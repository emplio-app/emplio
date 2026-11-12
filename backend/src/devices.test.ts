import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { GONE_NOTE, attach, cdpToken, cdpTokenOk, deviceFor, localBox, rpc, type Socket } from "./devices";

process.env.ENCRYPTION_KEY ??= "test-key-test-key-test-key-test-key";

// a stand-in for the app's end of the socket
function fake() {
  const events = new EventEmitter();
  const sent: any[] = [];
  const socket: Socket = {
    send: (d) => void sent.push(JSON.parse(d)),
    ping: () => {},
    close: () => events.emit("close"),
    terminate: () => events.emit("close"),
    on: ((e: string, fn: (...a: any[]) => void) => void events.on(e, fn)) as Socket["on"],
  };
  const say = (m: object) => events.emit("message", JSON.stringify(m));
  return { socket, sent, say, drop: () => events.emit("close") };
}
const dev = (id: string, userId = "u1") => ({ id, userId, name: id });

describe("devices", () => {
  test("a connected computer is found for its person only, and is gone when it drops", () => {
    const a = fake();
    attach(dev("11111111-1111-1111-1111-111111111111"), a.socket);
    expect(deviceFor("u1")?.name).toBe("11111111-1111-1111-1111-111111111111");
    expect(deviceFor("u2")).toBeUndefined();
    a.drop();
    expect(deviceFor("u1")).toBeUndefined();
  });

  test("the newest of a person's computers is used", () => {
    const a = fake();
    const b = fake();
    attach(dev("aaaaaaaa-1111-1111-1111-111111111111", "u3"), a.socket, 1000);
    attach(dev("bbbbbbbb-1111-1111-1111-111111111111", "u3"), b.socket, 2000);
    expect(deviceFor("u3")?.id).toStartWith("bbbbbbbb");
    b.drop();
    expect(deviceFor("u3")?.id).toStartWith("aaaaaaaa");
    a.drop();
  });

  test("an answer from the computer settles its request; an error rejects it", async () => {
    const a = fake();
    const conn = attach(dev("22222222-1111-1111-1111-111111111111", "u4"), a.socket);
    const ok = rpc(conn, "ping", { x: 1 });
    expect(a.sent[0]).toMatchObject({ id: 1, m: "ping", p: { x: 1 } });
    a.say({ id: 1, ok: true, r: "pong" });
    expect(await ok).toBe("pong");
    const bad = rpc(conn, "ping");
    a.say({ id: 2, ok: false, e: "nope" });
    await expect(bad).rejects.toThrow("nope");
    a.drop();
  });

  test("a command cut off by the computer going away comes back as a result, not an error", async () => {
    const a = fake();
    const conn = attach(dev("33333333-1111-1111-1111-111111111111", "u5"), a.socket);
    const box = localBox(conn, "w1");
    expect(box.local).toBe(true);
    const ran = box.run("sleep 100", { cwd: "/work", timeoutMs: 1000 });
    expect(a.sent[0]).toMatchObject({ m: "run", p: { box: "w1", command: "sleep 100", cwd: "/work" } });
    a.drop();
    expect(await ran).toEqual({ exitCode: 125, result: GONE_NOTE });
    // and it refuses to be kept awake, which sends sandbox.ts to the cloud
    await expect(box.keepAwake(1)).rejects.toThrow();
  });

  test("files cross as base64", async () => {
    const a = fake();
    const conn = attach(dev("44444444-1111-1111-1111-111111111111", "u6"), a.socket);
    const box = localBox(conn, "w1");
    const w = box.write("/work/a.txt", "héllo");
    expect(a.sent[0]).toMatchObject({ m: "write", p: { box: "w1", path: "/work/a.txt", b64: Buffer.from("héllo").toString("base64") } });
    a.say({ id: 1, ok: true, r: {} });
    await w;
    const r = box.readText("/work/a.txt");
    a.say({ id: 2, ok: true, r: { b64: Buffer.from("back").toString("base64") } });
    expect(await r).toBe("back");
    a.drop();
  });

  test("a browser link works only for the one it was made for", () => {
    const id = "dev_55555555-1111-1111-1111-111111111111_abc123";
    expect(cdpTokenOk(cdpToken(id))).toEqual({ browserId: id, deviceId: "55555555-1111-1111-1111-111111111111", key: "abc123" });
    expect(cdpTokenOk(cdpToken(id).replace("abc123", "abc124"))).toBeNull();
    expect(cdpTokenOk("dev_x.zzz")).toBeNull();
  });
});

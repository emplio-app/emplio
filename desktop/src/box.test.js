import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Boxes } from "./box.js";

let base, boxes;
const p = (command, extra = {}) => ({ box: "11112222-0000", name: "Acme", command, cwd: "/work", timeoutMs: 20000, ...extra });
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "emplio-box-")));
  boxes = new Boxes(base);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("commands see /work as their folder and print it as /work", async () => {
  const r = await boxes.run(1, p("pwd && echo hi > /work/tmp/a.txt && cat /work/tmp/a.txt && ls /work"));
  expect(r.exitCode).toBe(0);
  expect(r.result).toBe("/work\nhi\nin\nout\ntmp\n");
});

test("a command can't write outside the folder, or read the person's keys", async () => {
  const w = await boxes.run(2, p(`echo x > "${process.env.HOME}/emplio-should-not-exist" 2>&1; echo code=$?`));
  expect(w.result).toContain("code=1");
  expect(existsSync(join(process.env.HOME, "emplio-should-not-exist"))).toBe(false);
  const rd = await boxes.run(3, p(`ls "${process.env.HOME}/Documents" 2>&1; echo code=$?`));
  expect(rd.result).toContain("not permitted");
});

test("setsid, timeout and a git of its own work", async () => {
  const r = await boxes.run(4, p(`git config --global user.name Emplio && git config --global user.name && setsid true && echo setsid-ok && timeout 5 echo timeout-ok`));
  expect(r.result).toBe("Emplio\nsetsid-ok\ntimeout-ok\n");
  // git's settings went to the folder's own home, not the person's
  expect(existsSync(join(base, "acme-11112222", "home", ".gitconfig"))).toBe(true);
});

test("a long command is stopped at its timeout, as the cloud computer does", async () => {
  const r = await boxes.run(5, p("sleep 30", { timeoutMs: 700 }));
  expect(r).toEqual({ exitCode: 124, result: "Command timed out after 1s" });
});

test("a command can be cancelled", async () => {
  const running = boxes.run(6, p("sleep 30; echo late"));
  await Bun.sleep(300);
  boxes.cancel(6);
  const r = await running;
  expect(r.result).not.toContain("late");
});

test("files go in and out under /work only", async () => {
  await boxes.write(p("", { path: "/work/tmp/in.bin", b64: Buffer.from("héllo").toString("base64") }));
  expect(Buffer.from((await boxes.read(p("", { path: "/work/tmp/in.bin" }))).b64, "base64").toString()).toBe("héllo");
  await boxes.remove(p("", { path: "/work/tmp/in.bin" }));
  await expect(boxes.read(p("", { path: "/work/tmp/in.bin" }))).rejects.toThrow();
  await expect(boxes.write(p("", { path: "/etc/x", b64: "" }))).rejects.toThrow();
});

test("a background command keeps running after the command that started it", async () => {
  const r = await boxes.run(7, p(`setsid nohup bash -c 'sleep 1; echo done > /work/tmp/bg.txt' > /work/tmp/bg.log 2>&1 < /dev/null & echo $!`));
  expect(Number(r.result.trim())).toBeGreaterThan(0);
  await Bun.sleep(1800);
  expect((await boxes.read(p("", { path: "/work/tmp/bg.txt" })).then((x) => Buffer.from(x.b64, "base64").toString()))).toBe("done\n");
});

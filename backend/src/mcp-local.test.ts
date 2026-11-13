import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// @ts-expect-error the app is plain JavaScript
import { LocalMcp } from "../../desktop/src/mcp.js";
import { attach, type Socket } from "./devices";
import { DeviceTransport } from "./mcp";

process.env.ENCRYPTION_KEY ??= "test-key-test-key-test-key-test-key";

// the Mac app's end: a real LocalMcp starting a real MCP server, reached through the device link
function mac(allow: boolean) {
  const events = new EventEmitter();
  const app = new LocalMcp({ ask: async () => allow, allowed: () => [], remember: () => {}, emit: (m: object) => events.emit("message", JSON.stringify(m)) });
  const socket: Socket = {
    send: (d: string) => {
      const m = JSON.parse(d);
      if (m.m === "mcp.open") void app.open(m.p);
      else if (m.m === "mcp.send") app.send(m.p);
      else if (m.m === "mcp.close") app.close(m.p);
    },
    ping: () => {},
    close: () => {},
    terminate: () => {},
    on: ((e: string, fn: (...a: any[]) => void) => void events.on(e, fn)) as Socket["on"],
  };
  return { conn: attach({ id: crypto.randomUUID(), userId: "u1", name: "mac" }, socket), app };
}

test("a local MCP server's tools can be listed and called through the device link", async () => {
  const { conn, app } = mac(true);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(new DeviceTransport(conn, "k1", `bun ${import.meta.dir}/test-fixtures/echo-mcp.ts`));
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
  const r = (await client.callTool({ name: "echo", arguments: { text: "hi" } })) as { content: { text: string }[] };
  expect(r.content[0]!.text).toBe("you said hi");
  await client.close();
  app.closeAll();
});

test("when the person says no on their Mac, the reason comes back", async () => {
  const { conn } = mac(false);
  const t = new DeviceTransport(conn, "k2", "echo hi");
  const client = new Client({ name: "t", version: "1" });
  await expect(client.connect(t)).rejects.toThrow();
  expect(t.reason).toBe("the person said no on their Mac");
});

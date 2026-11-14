import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { WebSocketServer } from "ws";
import { Link, wait } from "./link.js";

// A server that stops answering without saying goodbye (its end dropped us) is noticed and connected to again.
test("a silent connection is ended and made again", async () => {
  // takes the connection, then never answers anything
  let connections = 0;
  const wss = createServer((sock) => {
    sock.once("data", (head) => {
      const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(String(head))[1];
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      connections++;
    });
  });
  await new Promise((r) => wss.listen(0, "127.0.0.1", r));
  const states = [];
  const link = new Link({ handlers: { request: () => ({}) }, onState: (s) => states.push(s), pingMs: 50, silentMs: 150 });
  link.start(`http://127.0.0.1:${wss.address().port}`, "t");
  await wait(2600); // the first retry waits 2 s
  link.stop();
  wss.close();
  expect(connections).toBeGreaterThanOrEqual(2);
  expect(states.filter((s) => s === "online").length).toBeGreaterThanOrEqual(2);
});

test("a connection that answers stays up", async () => {
  const wss = new WebSocketServer({ port: 0 });
  let connections = 0;
  wss.on("connection", () => connections++);
  const link = new Link({ handlers: { request: () => ({}) }, pingMs: 50, silentMs: 150 });
  link.start(`http://127.0.0.1:${wss.address().port}`, "t");
  await wait(600);
  link.stop();
  wss.close();
  expect(connections).toBe(1);
});

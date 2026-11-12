// The app's connection to the Emplio server (backend/src/devices.ts is the other end). It connects out, so the computer
// needs no open port; it reconnects by itself, and the server treats a silent connection as a computer that has gone.
import WebSocket from "ws";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class Link {
  // handlers: { request(method, params, id) -> result, note(method, params) }
  constructor({ handlers, onState }) {
    this.handlers = handlers;
    this.onState = onState;
    this.ws = null;
    this.target = null;
    this.try = 0;
    this.timer = null;
  }

  // Connect (and stay connected) to this server with this token.
  start(apiUrl, token) {
    this.stop();
    this.target = { apiUrl, token };
    this.try = 0;
    this.#open();
  }

  stop() {
    this.target = null;
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.removeAllListeners();
    ws?.on("error", () => {}); // closing one still connecting makes it emit an error
    try {
      ws?.close();
    } catch {}
    this.onState?.("off");
  }

  // The computer is going to sleep: drop the connection now rather than leave the server waiting to notice
  pause() {
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.removeAllListeners();
    ws?.on("error", () => {}); // closing one still connecting makes it emit an error
    try {
      ws?.terminate();
    } catch {}
    if (this.target) this.onState?.("connecting");
  }

  resume() {
    if (this.target && !this.ws) {
      this.try = 0;
      this.#open();
    }
  }

  #open() {
    const target = this.target;
    if (!target) return;
    this.onState?.("connecting");
    const url = `${target.apiUrl.replace(/^http/, "ws")}/devices/connect`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${target.token}` }, maxPayload: 256 * 1024 * 1024, perMessageDeflate: false });
    this.ws = ws;
    ws.on("open", () => {
      this.try = 0;
      this.onState?.("online");
    });
    ws.on("message", (raw) => void this.#message(ws, raw));
    ws.on("unexpected-response", (_req, res) => {
      // the server answered but wouldn't upgrade: not a connection problem
      this.#closed(ws, res.statusCode === 401 || res.statusCode === 403 ? 4001 : 0);
    });
    ws.on("close", (code) => this.#closed(ws, code));
    ws.on("error", () => {});
  }

  #closed(ws, code) {
    if (this.ws !== ws) return;
    this.ws = null;
    if (code === 4001) {
      // unknown to the server (removed, or signed in elsewhere): it has to be paired again from the page
      this.target = null;
      this.onState?.("needs-pairing");
      return;
    }
    this.onState?.("connecting");
    this.try++;
    this.timer = setTimeout(() => this.#open(), Math.min(30_000, 1000 * 2 ** Math.min(this.try, 5)));
  }

  send(message) {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
    } catch {}
  }

  async #message(ws, raw) {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof m.id !== "number") return void this.handlers.note?.(m.m, m.p ?? {});
    const reply = (body) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ id: m.id, ...body }));
    try {
      reply({ ok: true, r: (await this.handlers.request(m.m, m.p ?? {}, m.id)) ?? {} });
    } catch (error) {
      reply({ ok: false, e: error instanceof Error ? error.message : String(error) });
    }
  }
}

export { wait };

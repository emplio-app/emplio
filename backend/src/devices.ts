// The Emplio desktop app (desktop/ in this repo) on someone's computer; the routes it signs up and connects with are in
// device-routes.ts. While it's awake and connected, that person's
// commands and browser run on it, in a folder it keeps for them, instead of on this server's computer and browser
// (sandbox.ts and browser.ts ask `deviceFor`). When it isn't (closed, asleep, offline), nothing changes: the
// cloud's computer and browser take over, from the last save in git.
//
// The app connects out to us (a WebSocket), so it needs no open port. Everything below is one request/answer protocol on that socket:
//   server -> app   {id, m, p}           a request; the app answers {id, ok: true, r} or {id, ok: false, e}
//   server -> app   {m, p}               a note with no answer (cancel a command, pass on a browser message)
//   app -> server   {ev, ...}            browser messages coming back
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Box } from "./computer";

// the parts of a WebSocket (ws) used here, so a test can stand in for one
export type Socket = {
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", fn: (data: unknown) => void): void;
  on(event: "close" | "pong", fn: () => void): void;
};

type Waiting = { resolve: (value: any) => void; reject: (error: Error) => void; timer?: Timer };
export type Conn = {
  id: string;
  userId: string;
  name: string;
  // the app's process.platform. Only a Mac ("darwin") does Emplio's work (commands and browser); a Linux one just shows
  // notifications, until commands there get a fence like the Mac's (desktop/src/box.js) and its browser's downloads reach the cloud computer
  platform?: string;
  socket: Socket;
  next: number;
  pending: Map<number, Waiting>;
  // browser messages going back out, by connection id
  cdp: Map<string, { data: (text: string) => void; closed: () => void }>;
  alive: boolean;
  since: number;
};

const online = new Map<string, Conn>();
const PING_MS = 10_000;
// an app that stops answering pings this long is gone (a laptop whose lid shut leaves no goodbye)
const SILENT_MS = 25_000;

export class DeviceGone extends Error {
  constructor() {
    super("the computer went offline");
  }
}

// --- who's connected -------------------------------------------------------------------------------------
const goneListeners: ((deviceId: string) => void)[] = [];
// told when a device drops off (browser.ts forgets its browsers)
export const onGone = (fn: (deviceId: string) => void) => void goneListeners.push(fn);

// This person's computer, if one of theirs is connected now (the newest if several); `work`: one that runs commands and a browser.
export function deviceFor(userId: string, work = false): Conn | undefined {
  let found: Conn | undefined;
  for (const c of online.values())
    if (c.userId === userId && c.alive && (!work || c.platform === "darwin") && (!found || c.since > found.since)) found = c;
  return found;
}
export const deviceById = (id: string) => online.get(id);
export const connected = () => [...online.values()].filter((c) => c.alive);
export const isOnline = (id: string) => online.get(id)?.alive === true;

function drop(conn: Conn) {
  if (online.get(conn.id) !== conn) return;
  online.delete(conn.id);
  conn.alive = false;
  for (const w of conn.pending.values()) {
    clearTimeout(w.timer);
    w.reject(new DeviceGone());
  }
  conn.pending.clear();
  for (const c of conn.cdp.values()) c.closed();
  conn.cdp.clear();
  for (const fn of goneListeners) fn(conn.id);
}

// A device that has connected. A second connection from the same device replaces the first.
export function attach(device: { id: string; userId: string; name: string; platform?: string }, socket: Socket, now = Date.now()): Conn {
  const old = online.get(device.id);
  const conn: Conn = { ...device, socket, next: 0, pending: new Map(), cdp: new Map(), alive: true, since: now };
  online.set(device.id, conn);
  if (old) {
    drop(old);
    old.socket.close(4000, "replaced");
  }
  let heard = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - heard > SILENT_MS) return socket.terminate();
    try {
      socket.ping();
    } catch {}
  }, PING_MS);
  socket.on("pong", () => (heard = Date.now()));
  socket.on("message", (raw) => {
    heard = Date.now();
    let m: any;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (typeof m.id === "number") {
      const w = conn.pending.get(m.id);
      if (!w) return;
      conn.pending.delete(m.id);
      clearTimeout(w.timer);
      if (m.ok) w.resolve(m.r);
      else w.reject(new Error(String(m.e ?? "the computer refused")));
    } else if (m.ev === "cdp.data") conn.cdp.get(m.conn)?.data(String(m.data));
    else if (m.ev === "cdp.closed") {
      conn.cdp.get(m.conn)?.closed();
      conn.cdp.delete(m.conn);
    }
  });
  socket.on("close", () => {
    clearInterval(timer);
    drop(conn);
  });
  return conn;
}

// Ask the device to do something and wait for its answer. Rejects with DeviceGone if it drops off meanwhile.
export function rpc<T = any>(conn: Conn, m: string, p: object = {}, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  if (!conn.alive) return Promise.reject(new DeviceGone());
  const id = ++conn.next;
  return new Promise<T>((resolve, reject) => {
    const w: Waiting = { resolve, reject };
    if (o.timeoutMs) w.timer = setTimeout(() => (conn.pending.delete(id), reject(new Error(`the computer didn't answer ${m} in time`))), o.timeoutMs);
    conn.pending.set(id, w);
    o.signal?.addEventListener(
      "abort",
      () => {
        notify(conn, "cancel", { id });
      },
      { once: true },
    );
    try {
      conn.socket.send(JSON.stringify({ id, m, p }));
    } catch (error) {
      conn.pending.delete(id);
      clearTimeout(w.timer);
      reject(error as Error);
    }
  });
}

export function notify(conn: Conn, m: string, p: object = {}) {
  if (!conn.alive) return;
  try {
    conn.socket.send(JSON.stringify({ m, p }));
  } catch {}
}

// --- the computer ----------------------------------------------------------------------------------------
// The same shape as the cloud's box (computer.ts), so sandbox.ts uses it unchanged. The device keeps one folder per
// business, with /work inside it: it maps the paths in commands onto that folder (desktop/src/mac.ts).
export const GONE_NOTE =
  "Your computer went offline while this command was running (closed, asleep or disconnected), so it stopped part-way. Nothing else of it ran. Check what it changed before running it again; your next command runs on the cloud computer, with the company files as of the last save.";

export function localBox(conn: Conn, workspaceId: string, name = ""): Box {
  const ask = <T>(m: string, p: object, o?: { timeoutMs?: number; signal?: AbortSignal }) => rpc<T>(conn, m, { box: workspaceId, name, ...p }, o);
  const b64 = (bytes: Uint8Array | string) => Buffer.from(typeof bytes === "string" ? bytes : bytes).toString("base64");
  return {
    id: `local:${conn.id}:${workspaceId}`,
    local: true,
    async run(command, { cwd, env, timeoutMs, signal }) {
      try {
        return await ask<{ exitCode: number; result: string }>("run", { command, cwd, env, timeoutMs }, { signal, timeoutMs: timeoutMs + 30_000 });
      } catch (error) {
        if (error instanceof DeviceGone) return { exitCode: 125, result: GONE_NOTE };
        throw error;
      }
    },
    write: (path, bytes) => ask("write", { path, b64: b64(bytes) }, { timeoutMs: 120_000 }),
    read: async (path) => new Uint8Array(Buffer.from((await ask<{ b64: string }>("read", { path }, { timeoutMs: 120_000 })).b64, "base64")),
    readText: async (path) => Buffer.from((await ask<{ b64: string }>("read", { path }, { timeoutMs: 120_000 })).b64, "base64").toString(),
    remove: async (path) => void (await ask("remove", { path }, { timeoutMs: 60_000 })),
    // a computer that is on needs no keeping awake; one that has gone refuses, which sends sandbox.ts to look again (and to the cloud)
    keepAwake: async () => {
      if (!conn.alive) throw new DeviceGone();
    },
    kill: async () => {},
  };
}

// --- browser messages through this server -----------------------------------------------------------------
// The app's Chrome only listens on its own computer. Whoever drives it (the agent's computer, or this server for the
// live view) goes through here, with a link only this server can make: /device-cdp/<browser id>.<signature>/...
const secret = () => process.env.ENCRYPTION_KEY!;
export const signCdp = (browserId: string) => createHmac("sha256", secret()).update(`device-cdp:${browserId}`).digest("base64url");
export const cdpToken = (browserId: string) => `${browserId}.${signCdp(browserId)}`;
export function cdpTokenOk(t: string): { browserId: string; deviceId: string; key: string } | null {
  const dot = t.lastIndexOf(".");
  const browserId = t.slice(0, dot);
  const given = Buffer.from(t.slice(dot + 1));
  const want = Buffer.from(signCdp(browserId));
  if (dot < 1 || given.length !== want.length || !timingSafeEqual(given, want)) return null;
  const m = /^dev_([0-9a-f-]{36})_([a-z0-9]+)$/.exec(browserId);
  return m ? { browserId, deviceId: m[1]!, key: m[2]! } : null;
}
// Commands may run on the person's own computer (or a cloud one), so the link must work from there: the live server
// sets only WEBHOOK_URL, and a localhost fallback there sent the Mac's browser tool to a port it doesn't have.
const apiBase = () => process.env.PUBLIC_API_URL ?? process.env.WEBHOOK_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
export const cdpUrlOf = (browserId: string) => `${apiBase()}/device-cdp/${cdpToken(browserId)}`;
export const wsBase = () => apiBase().replace(/^http/, "ws");

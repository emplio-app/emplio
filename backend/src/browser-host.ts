// Who runs the browsers: Chromium in Docker, one per chat, started and stopped by the runner (runner/runner.ts).
// It starts empty each time, so the person's saved sign-ins are put back (browser.ts restoreState). It has none of
// the stealth, CAPTCHA solving or proxies of a paid browser service, so some sites will block it.
// Also the live view: this server shows the browser's screen from Chromium's own screencast and passes clicks and
// keys back, so a person can watch it and sign in.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { devtools, openBrowser, sig, type Owner } from "./browser";
import { runner } from "./computer";

export type HostedBrowser = { id: string; liveUrl: string; cdpUrl: string; timeoutAt: string; startedAt?: string };
export const RESTORE_SIGN_INS: boolean = true;
// what the agent is told its browser is (sandbox.ts)
export const BROWSER_KIND: string = "a Chromium browser on this server";

type Started = { id: string; cdpUrl: string; timeoutAt: string; startedAt: string };

const signed = (chat: string, ends: number) => `${ends}.${sig(`live.${chat}.${ends}`)}`;
function signatureOk(chat: string, t = "") {
  const ends = Number(t.split(".")[0]);
  const want = Buffer.from(signed(chat, ends));
  const given = Buffer.from(t);
  return ends > Date.now() && given.length === want.length && timingSafeEqual(given, want);
}
const liveUrlOf = (chat: string, timeoutAt: string) =>
  `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/browser-live/${chat}?t=${encodeURIComponent(signed(chat, new Date(timeoutAt).getTime()))}`;

async function ready(cdpUrl: string) {
  for (let i = 0; i < 60; i++) {
    const up = await fetch(`${cdpUrl}/json/version`)
      .then((r) => r.ok)
      .catch(() => false);
    if (up) return;
    await Bun.sleep(500);
  }
  throw new Error("the browser didn't start");
}

// _size: for services whose page size is fixed at the start. This one takes a new size while running, so it's never asked.
export async function startHosted(conversationId: string, owner: Owner, _size?: { width: number; height: number }): Promise<HostedBrowser> {
  const r = await runner("/browsers", { method: "POST", body: JSON.stringify({ chat: conversationId, workspaceId: owner.workspaceId, userId: owner.userId }) });
  const b = (await r.json()) as Started;
  await ready(b.cdpUrl);
  return { ...b, liveUrl: liveUrlOf(conversationId, b.timeoutAt) };
}

// No proxies here: the browser stays on this server's own connection.
export const useProxy = async (_id: string, _owner: Owner) => false;

export async function listHosted(conversationId: string): Promise<HostedBrowser[]> {
  const found = (await (await runner(`/browsers?${new URLSearchParams({ chat: conversationId })}`)).json()) as Started[];
  return found.map((b) => ({ ...b, liveUrl: liveUrlOf(conversationId, b.timeoutAt) }));
}

export const stopHosted = (id: string) => runner(`/browsers/${id}`, { method: "DELETE" });

export async function hostedDownloads(id: string) {
  const files = (await (await runner(`/browsers/${id}/downloads`)).json()) as { path: string; size: number; lastModified: string }[];
  const base = `${process.env.COMPUTER_RUNNER_URL ?? "http://runner:4100"}/browsers/${id}/download`;
  // only this server ever fetches these (sandbox.ts copies a download into the computer), never a person or the agent
  return files.map((f) => ({ ...f, url: `${base}?${new URLSearchParams({ path: f.path, token: process.env.RUNNER_TOKEN ?? "" })}` as string | null }));
}

// clicks and keys from the page below
type Input =
  | { t: "mouse"; type: "mouseMoved" | "mousePressed" | "mouseReleased"; x: number; y: number; button: "none" | "left" | "middle" | "right"; clickCount: number; modifiers: number }
  | { t: "wheel"; x: number; y: number; dx: number; dy: number }
  | { t: "key"; type: "keyDown" | "keyUp" | "rawKeyDown"; key: string; code: string; keyCode: number; text?: string; modifiers: number }
  | { t: "paste"; text: string };

async function live(socket: { send(data: string): void; on(event: string, fn: (data: unknown) => void): void; close(): void }, cdpUrl: string) {
  const cdp = await devtools(cdpUrl);
  let session: string | undefined;
  let target: string | undefined;

  // always the newest tab, so a link that opens a new one is followed
  const follow = async () => {
    const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string }[] };
    const newest = targetInfos.filter((t) => t.type === "page").at(-1);
    if (!newest || newest.targetId === target) return;
    const old = session;
    target = newest.targetId;
    const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId: target, flatten: true })) as { sessionId: string };
    session = sessionId;
    if (old) void cdp.send("Page.stopScreencast", {}, old).catch(() => {});
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 }, sessionId);
  };

  cdp.on((method, p, from) => {
    if (method === "Page.screencastFrame" && from === session) {
      socket.send(JSON.stringify({ data: p.data, width: p.metadata.deviceWidth, height: p.metadata.deviceHeight }));
      void cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, from).catch(() => {});
    } else if (method === "Target.targetCreated" || method === "Target.targetDestroyed") void follow().catch(() => {});
  });
  socket.on("message", (raw) => {
    if (!session) return;
    let m: Input;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    const send = (method: string, params: object) => void cdp.send(method, params, session).catch(() => {});
    if (m.t === "mouse") send("Input.dispatchMouseEvent", { type: m.type, x: m.x, y: m.y, button: m.button, clickCount: m.clickCount, modifiers: m.modifiers });
    else if (m.t === "wheel") send("Input.dispatchMouseEvent", { type: "mouseWheel", x: m.x, y: m.y, deltaX: m.dx, deltaY: m.dy });
    else if (m.t === "key") send("Input.dispatchKeyEvent", { type: m.type, key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, text: m.text, modifiers: m.modifiers });
    else if (m.t === "paste") send("Input.insertText", { text: String(m.text).slice(0, 100_000) });
  });
  socket.on("close", () => cdp.close());
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  await follow();
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser</title>
<style>html,body{margin:0;height:100%;background:#111;color:#eee;font:15px system-ui;overflow:hidden}
body{display:flex;align-items:flex-start;justify-content:center}canvas{max-width:100%;max-height:100%;touch-action:none;cursor:default}p{padding:24px}textarea{position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;font-size:16px}</style>
<canvas hidden></canvas><textarea autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Type into the browser"></textarea><p id="wait">Connecting to the browser...</p>
<script>
const canvas = document.querySelector("canvas"), kb = document.querySelector("textarea"), ctx = canvas.getContext("2d"), wait = document.getElementById("wait");
const proto = location.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(proto + "//" + location.host + location.pathname + "/ws" + location.search);
const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const img = new Image();
img.onload = () => { if (canvas.width !== img.width) canvas.width = img.width; if (canvas.height !== img.height) canvas.height = img.height; ctx.drawImage(img, 0, 0); };
let width = 1, height = 1;
ws.onmessage = (e) => { const f = JSON.parse(e.data); width = f.width; height = f.height; canvas.hidden = false; wait.hidden = true; img.src = "data:image/jpeg;base64," + f.data; };
ws.onclose = () => { canvas.hidden = true; wait.hidden = false; wait.textContent = "This browser has closed."; };
const at = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * width, y: (e.clientY - r.top) / r.height * height }; };
const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTON = ["left", "middle", "right"];
const mouse = (type, e, button, clickCount) => send({ t: "mouse", type, ...at(e), button, clickCount, modifiers: mods(e) });
canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); mouse("mousePressed", e, BUTTON[e.button] || "left", 1); });
// keys go through a hidden text box: a canvas can't take typing, and a phone only shows its keyboard for a text box
canvas.addEventListener("pointerup", (e) => { mouse("mouseReleased", e, BUTTON[e.button] || "left", 1); kb.focus(); });
let last = 0;
canvas.addEventListener("pointermove", (e) => { const now = Date.now(); if (now - last < 40) return; last = now; mouse("mouseMoved", e, "none", 0); });
canvas.addEventListener("wheel", (e) => { e.preventDefault(); send({ t: "wheel", ...at(e), dx: e.deltaX, dy: e.deltaY }); }, { passive: false });
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
const key = (type, e, text) => send({ t: "key", type, key: e.key, code: e.code, keyCode: e.keyCode, text, modifiers: mods(e) });
kb.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229 || ((e.metaKey || e.ctrlKey) && e.key === "v")) return;
  e.preventDefault();
  if (e.key === "Enter") key("keyDown", e, "\\r");
  else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) key("keyDown", e, e.key);
  else key("rawKeyDown", e);
});
kb.addEventListener("keyup", (e) => { if (e.isComposing || e.keyCode === 229) return; e.preventDefault(); key("keyUp", e); });
// phone keyboards and other languages' keyboards send text, not key presses
const press = (k, code, keyCode, text) => { key("keyDown", { key: k, code, keyCode }, text); key("keyUp", { key: k, code, keyCode }); };
const flush = () => {
  const text = kb.value;
  kb.value = "";
  if (text === "\\n") press("Enter", "Enter", 13, "\\r");
  else if (text) send({ t: "paste", text });
};
kb.addEventListener("input", (e) => { if (!e.isComposing) flush(); });
kb.addEventListener("compositionend", flush);
kb.addEventListener("beforeinput", (e) => { if (e.inputType === "deleteContentBackward" && !kb.value) press("Backspace", "Backspace", 8); });
addEventListener("paste", (e) => { e.preventDefault(); const text = e.clipboardData.getData("text"); if (text) send({ t: "paste", text }); });
</script>`;

export async function browserHostRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>("/browser-live/:id", async (req, reply) => {
    if (!signatureOk(req.params.id, req.query.t)) return reply.code(403).type("text/html").send("<p>This link has expired. Ask for a new one.</p>");
    return reply.type("text/html").header("Referrer-Policy", "no-referrer").send(PAGE);
  });
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>("/browser-live/:id/ws", { websocket: true }, async (socket, req) => {
    const browser = signatureOk(req.params.id, req.query.t) ? await openBrowser(req.params.id) : null;
    if (!browser) return socket.close();
    await live(socket, browser.cdpUrl).catch((error) => {
      console.error("live browser view failed", error);
      socket.close();
    });
  });
}

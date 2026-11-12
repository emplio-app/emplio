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
export const liveUrlOf = (chat: string, timeoutAt: string, prefix = "browser-live") =>
  `${process.env.PUBLIC_API_URL ?? "http://localhost:4000"}/${prefix}/${chat}?t=${encodeURIComponent(signed(chat, new Date(timeoutAt).getTime()))}`;

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
  | { t: "paste"; text: string }
  | { t: "size"; width: number; height: number }
  | { t: "tab"; act: "activate" | "close" | "new" | "go" | "back" | "forward" | "reload"; id?: string; url?: string };

// what was typed in the address bar: a web address, or a search
const addressOf = (text: string) => {
  const t = text.trim();
  if (!t) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(about|data|file):/i.test(t)) return t;
  if (/^[^\s/]+\.[a-z]{2,}([/:?#].*)?$/i.test(t) || /^localhost(:\d+)?([/?#].*)?$/i.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
};

async function live(socket: { send(data: string): void; on(event: string, fn: (data: unknown) => void): void; close(): void }, cdpUrl: string) {
  const cdp = await devtools(cdpUrl);
  let session: string | undefined;
  let target: string | undefined;

  // the tab chosen in the bar, else always the newest, so a link that opens a new one is followed
  let chosen: string | undefined;
  const tabs = new Map<string, { id: string; title: string; url: string }>();
  let history = { canBack: false, canForward: false };
  const pushTabs = () => {
    const at = session;
    const send = () => socket.send(JSON.stringify({ tabs: [...tabs.values()].map((t) => ({ ...t, active: t.id === target })), ...history }));
    if (!at) return send();
    void cdp
      .send("Page.getNavigationHistory", {}, at)
      .then((h) => {
        const { currentIndex, entries } = h as { currentIndex: number; entries: unknown[] };
        history = { canBack: currentIndex > 0, canForward: currentIndex < entries.length - 1 };
      })
      .catch(() => {})
      .then(send);
  };
  // the page fills the viewer's panel: its width is the browser's own (1280 unless the browser command set another), its height follows the panel
  let stage = { width: 0, height: 0 };
  let pageWidth = 1280;
  const fit = () => {
    if (!session || stage.width < 50 || stage.height < 50) return;
    void cdp.send("Emulation.setDeviceMetricsOverride", { width: pageWidth, height: Math.max(200, Math.round((pageWidth * stage.height) / stage.width)), deviceScaleFactor: 1, mobile: false }, session).catch(() => {});
  };
  const follow = async () => {
    const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; title: string; url: string }[] };
    const pages = targetInfos.filter((t) => t.type === "page");
    tabs.clear();
    for (const t of pages) tabs.set(t.targetId, { id: t.targetId, title: t.title, url: t.url });
    const pick = (chosen && tabs.has(chosen) ? chosen : pages.at(-1)?.targetId) as string | undefined;
    if (!pick || pick === target) return pushTabs();
    const old = session;
    target = pick;
    const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId: target, flatten: true })) as { sessionId: string };
    session = sessionId;
    if (old) void cdp.send("Page.stopScreencast", {}, old).catch(() => {});
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 }, sessionId);
    fit();
    pushTabs();
  };

  // A screencast only sends a frame when the page changes, so a page that is already still (or one that never painted)
  // would leave the viewer on "Connecting": when nothing has come for a moment, one picture is taken the other way.
  let lastFrame = 0;
  const still = setInterval(async () => {
    if (!session || Date.now() - lastFrame < 1500) return;
    try {
      const at = session;
      const [{ data }, metrics] = (await Promise.all([cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }, at), cdp.send("Page.getLayoutMetrics", {}, at)])) as [{ data: string }, { cssVisualViewport: { clientWidth: number; clientHeight: number } }];
      if (at === session && Date.now() - lastFrame >= 1500) {
        lastFrame = Date.now();
        socket.send(JSON.stringify({ data, width: Math.round(metrics.cssVisualViewport.clientWidth), height: Math.round(metrics.cssVisualViewport.clientHeight) }));
      }
    } catch {}
  }, 1500);

  cdp.on((method, p, from) => {
    if (method === "Page.screencastFrame" && from === session) {
      lastFrame = Date.now();
      socket.send(JSON.stringify({ data: p.data, width: p.metadata.deviceWidth, height: p.metadata.deviceHeight }));
      void cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, from).catch(() => {});
    } else if (method === "Target.targetCreated") {
      chosen = undefined;
      void follow().catch(() => {});
    } else if (method === "Target.targetDestroyed") void follow().catch(() => {});
    else if (method === "Target.targetInfoChanged") {
      const t = tabs.get(p.targetInfo?.targetId);
      if (t) (Object.assign(t, { title: p.targetInfo.title, url: p.targetInfo.url }), pushTabs());
    }
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
    if (m.t === "size") {
      stage = { width: Number(m.width) || 0, height: Number(m.height) || 0 };
      return fit();
    }
    if (m.t === "tab") {
      const act = m.act;
      if (act === "activate" && m.id && tabs.has(m.id)) {
        chosen = m.id;
        void cdp.send("Target.activateTarget", { targetId: m.id }).catch(() => {});
        void follow().catch(() => {});
      } else if (act === "close" && m.id) void cdp.send("Target.closeTarget", { targetId: m.id }).catch(() => {});
      else if (act === "new") void cdp.send("Target.createTarget", { url: "about:blank" }).catch(() => {});
      else if (act === "go") send("Page.navigate", { url: addressOf(String(m.url ?? "").slice(0, 2000)) });
      else if (act === "reload") send("Page.reload", {});
      else if (act === "back" || act === "forward") {
        const at = session;
        void cdp.send("Page.getNavigationHistory", {}, at).then((h) => {
          const { currentIndex, entries } = h as { currentIndex: number; entries: { id: number }[] };
          const e = entries[currentIndex + (act === "back" ? -1 : 1)];
          if (e) void cdp.send("Page.navigateToHistoryEntry", { entryId: e.id }, at).catch(() => {});
        }).catch(() => {});
      }
      return;
    }
    if (m.t === "mouse") send("Input.dispatchMouseEvent", { type: m.type, x: m.x, y: m.y, button: m.button, clickCount: m.clickCount, modifiers: m.modifiers });
    else if (m.t === "wheel") send("Input.dispatchMouseEvent", { type: "mouseWheel", x: m.x, y: m.y, deltaX: m.dx, deltaY: m.dy });
    else if (m.t === "key") send("Input.dispatchKeyEvent", { type: m.type, key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, text: m.text, modifiers: m.modifiers });
    else if (m.t === "paste") send("Input.insertText", { text: String(m.text).slice(0, 100_000) });
  });
  socket.on("close", () => (clearInterval(still), cdp.close()));
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  await follow();
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser</title>
<style>
:root{color-scheme:dark;--strip:#1d1d1f;--bar:#2c2c2e;--text:#f2f2f4;--mute:#98989d}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:transparent;color:var(--text);font:13px system-ui,-apple-system,sans-serif;overflow:hidden}
.card{height:100%;display:flex;flex-direction:column;background:var(--strip);border-radius:14px 14px 0 0;overflow:hidden}
.tabs{flex:none;display:flex;align-items:flex-end;gap:4px;height:44px;padding:10px 12px 0 16px;user-select:none;overflow:hidden}
.dots{display:flex;gap:9px;align-self:center;margin-right:16px}.dots i{width:12px;height:12px;border-radius:50%;background:#5c5c60}
.tab{display:flex;align-items:center;gap:8px;min-width:0;flex:0 1 190px;height:34px;padding:0 8px 0 12px;border-radius:12px 12px 0 0;color:var(--mute);cursor:default}
.tab.on{background:var(--bar);color:var(--text)}.tab span{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.fav{width:16px;height:16px;flex:none;border-radius:50%;background:#5c5c60}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0}
.x{width:20px;height:20px;border-radius:50%;color:var(--mute);display:grid;place-items:center}
.x:hover,.icon:hover:not(:disabled){background:rgba(255,255,255,.1)}
.icon{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;color:var(--text)}.icon:disabled{color:#5c5c60;cursor:default}.plus{align-self:center}
svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.bar{flex:none;display:flex;align-items:center;gap:6px;height:48px;padding:0 12px;background:var(--bar)}
#url{flex:1;min-width:0;height:34px;padding:0 18px;border:1px solid transparent;border-radius:17px;background:var(--strip);color:var(--text);font:14px system-ui,-apple-system,sans-serif;outline:none}#url:focus{border-color:#5bb98a}
#stage{flex:1;min-height:0;background:#111;overflow:hidden}canvas{display:block;width:100%;height:auto;touch-action:none;cursor:default}#wait{margin:0;padding:24px;text-align:center}
textarea{position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;border:0;padding:0;font-size:16px}
</style>
<div class="card"><div class="tabs" id="tabs"></div>
<div class="bar"><button class="icon" id="back" title="Back"><svg viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></button><button class="icon" id="fwd" title="Forward"><svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg></button><button class="icon" id="reload" title="Reload"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5"/></svg></button><input id="url" spellcheck="false" autocomplete="off" placeholder="Search or enter a web address"></div>
<div id="stage"><canvas hidden></canvas><p id="wait">Connecting to the browser...</p></div></div>
<textarea autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Type into the browser"></textarea>
<script>
const canvas = document.querySelector("canvas"), kb = document.querySelector("textarea"), ctx = canvas.getContext("2d"), wait = document.getElementById("wait");
const proto = location.protocol === "https:" ? "wss:" : "ws:";
const ws = new WebSocket(proto + "//" + location.host + location.pathname + "/ws" + location.search);
const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const img = new Image();
img.onload = () => { if (canvas.width !== img.width) canvas.width = img.width; if (canvas.height !== img.height) canvas.height = img.height; ctx.drawImage(img, 0, 0); };
let width = 1, height = 1;
const tabsEl = document.getElementById("tabs"), urlEl = document.getElementById("url"), stage = document.getElementById("stage");
const tab = (act, id, url) => send({ t: "tab", act, id, url });
const SVG = (d, w) => '<svg viewBox="0 0 24 24"' + (w ? ' style="width:' + w + 'px;height:' + w + 'px"' : "") + '><path d="' + d + '"/></svg>';
function drawTabs(f) {
  tabsEl.textContent = "";
  const dots = document.createElement("div"); dots.className = "dots"; dots.innerHTML = "<i></i><i></i><i></i>"; tabsEl.append(dots);
  for (const t of f.tabs) {
    const el = document.createElement("div"); el.className = "tab" + (t.active ? " on" : ""); el.title = t.url;
    el.onmousedown = () => tab("activate", t.id);
    el.append(Object.assign(document.createElement("i"), { className: "fav" }));
    el.append(Object.assign(document.createElement("span"), { textContent: t.title || t.url || "New tab" }));
    const x = Object.assign(document.createElement("button"), { className: "x", title: "Close tab", innerHTML: SVG("M6 6l12 12M18 6L6 18", 12) });
    x.onmousedown = (e) => (e.stopPropagation(), tab("close", t.id)); el.append(x); tabsEl.append(el);
    if (t.active && document.activeElement !== urlEl) urlEl.value = t.url === "about:blank" ? "" : t.url;
  }
  const add = Object.assign(document.createElement("button"), { className: "icon plus", title: "New tab", innerHTML: SVG("M12 5v14M5 12h14") }); add.onclick = () => tab("new"); tabsEl.append(add);
  document.getElementById("back").disabled = !f.canBack; document.getElementById("fwd").disabled = !f.canForward;
}
document.getElementById("back").onclick = () => tab("back"); document.getElementById("fwd").onclick = () => tab("forward"); document.getElementById("reload").onclick = () => tab("reload");
urlEl.addEventListener("focus", () => urlEl.select());
urlEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { tab("go", undefined, urlEl.value); urlEl.blur(); } });
// the page is laid out to fill the whole panel (its width stays the browser's own): say how big the panel is
let sizeTimer;
const tellSize = () => { clearTimeout(sizeTimer); sizeTimer = setTimeout(() => send({ t: "size", width: stage.clientWidth, height: stage.clientHeight }), 200); };
new ResizeObserver(tellSize).observe(stage); ws.addEventListener("open", tellSize);
ws.onmessage = (e) => { const f = JSON.parse(e.data); if (f.tabs) return drawTabs(f); width = f.width; height = f.height; canvas.hidden = false; wait.hidden = true; img.src = "data:image/jpeg;base64," + f.data; };
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

// The live view page and its socket, under /<prefix>/<chat>. The device browser (device-browser.ts) has its own prefix.
export async function liveRoutes(app: FastifyInstance, prefix: string) {
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>(`/${prefix}/:id`, async (req, reply) => {
    if (!signatureOk(req.params.id, req.query.t)) return reply.code(403).type("text/html").send("<p>This link has expired. Ask for a new one.</p>");
    return reply.type("text/html").header("Referrer-Policy", "no-referrer").send(PAGE);
  });
  app.get<{ Params: { id: string }; Querystring: { t?: string } }>(`/${prefix}/:id/ws`, { websocket: true }, async (socket, req) => {
    const browser = signatureOk(req.params.id, req.query.t) ? await openBrowser(req.params.id) : null;
    if (!browser) return socket.close();
    await live(socket, browser.cdpUrl).catch((error) => {
      console.error("live browser view failed", error);
      socket.close();
    });
  });
}

export const browserHostRoutes = (app: FastifyInstance) => liveRoutes(app, "browser-live");
export const deviceLiveRoutes = (app: FastifyInstance) => liveRoutes(app, "device-live");

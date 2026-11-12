// The agent's browser, inside the Emplio window: real Chromium tabs (Electron's own) drawn over the page's browser panel,
// with a tab strip and toolbar of ours. The agent drives it through the same DevTools protocol as before: the app's own
// DevTools port (see main.js) is reached by the server through the app's connection (link.js), after cdp-filter.js has
// taken the app's own window out of sight. Sign-ins live in Electron's default session; the app's own window uses another.
//
// It has the same shape as Browsers (chrome.js): start, list, stop, http, connect, send, close, stopAll.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebContentsView, dialog, ipcMain, session } from "electron";
import WebSocket from "ws";
import { allowedPath, createFilter, listPage } from "./cdp-filter.js";

const HOURS = 4;
const TABS_H = 44;
const BAR_H = 48;
const TOOLBAR = TABS_H + BAR_H;
// the page size pages are laid out at, like the cloud browsers: Emplio's browser command can change it (set viewport / set device)
const DESKTOP = { width: 1280, height: 800, mobile: false };
const key = () => `e${Math.random().toString(36).slice(2, 7).padEnd(5, "0")}`;
const sameSite = { unspecified: undefined, no_restriction: "None", lax: "Lax", strict: "Strict" };

// what you typed in the address bar: a web address, or a search
export function addressOf(text) {
  const t = String(text ?? "").trim();
  if (!t) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(about|data|file):/i.test(t)) return t;
  if (/^[^\s/]+\.[a-z]{2,}([/:?#].*)?$/i.test(t) || /^localhost(:\d+)?([/?#].*)?$/i.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

export class Panes {
  // getWindow: Emplio's window (none when the app is only in the menu bar), the pane is drawn in it. getHost: a window that is
  // never shown, where the browser lives while it isn't drawn in Emplio's window (so it works with the app closed too).
  // chrome: the backup Chrome (Browsers). chromeFor: finds or fetches the backup Chrome's program
  constructor({ getWindow, getHost, userData, chrome, chromeFor }) {
    this.getWindow = getWindow;
    this.getHost = getHost;
    this.userData = userData;
    this.chrome = chrome;
    this.chromeFor = chromeFor;
    this.browsers = new Map();
    this.links = new Map();
    this.shown = null; // { chat, x, y, width, height, visible }
    this.ui = null;
    this.tabId = 0;
    this.session = null;
    this.signingIn = false;
    this.signIn = null;
  }

  // --- the app's DevTools port ---------------------------------------------------------------------------
  async port() {
    for (let i = 0; i < 40; i++) {
      const text = await readFile(join(this.userData, "DevToolsActivePort"), "utf8").catch(() => "");
      const port = Number(text.split("\n")[0]);
      // the file can be left from an earlier run: only a port that answers counts
      if (port && (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false))) return port;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("the app's browser port isn't open");
  }

  #session() {
    if (this.session) return this.session;
    const ses = (this.session = session.defaultSession);
    // looks like Chrome to the sites: no "Electron" or app name in it
    ses.setUserAgent(ses.getUserAgent().replace(/\s?Electron\/\S+/, "").replace(/\s?Emplio\/\S+/, ""));
    ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    ses.on("will-download", (_event, item) => {
      const b = [...this.browsers.values()].at(-1);
      if (b) item.setSavePath(join(b.work, "tmp", "downloads", item.getFilename()));
    });
    return ses;
  }

  // --- start, list, stop --------------------------------------------------------------------------------------
  async start({ work, chat }) {
    const ses = this.#session();
    await this.port();
    // a clean start: only what the server puts back (a leftover from an earlier run, or from this app, must not be taken for a sign-in)
    if (!this.browsers.size) await ses.clearStorageData().catch(() => {});
    const b = { key: key(), chat, work, tabs: [], active: null, size: DESKTOP, startedAt: new Date(), timeoutAt: new Date(Date.now() + HOURS * 3_600_000) };
    this.browsers.set(b.key, b);
    try {
      await this.newTab(b, "about:blank");
    } catch (error) {
      this.stop(b.key);
      throw error;
    }
    return { key: b.key, startedAt: b.startedAt.toISOString(), timeoutAt: b.timeoutAt.toISOString() };
  }

  list(chat) {
    return [...this.browsers.values()].filter((b) => b.chat === chat).map((b) => ({ key: b.key, startedAt: b.startedAt.toISOString(), timeoutAt: b.timeoutAt.toISOString() }));
  }

  has(id) {
    return this.browsers.has(id);
  }

  stop(id) {
    const b = this.browsers.get(id);
    if (!b) return;
    this.browsers.delete(id);
    for (const t of b.tabs) this.#dispose(t);
    for (const l of this.links.values()) if (l.id === id) (l.closed = true), l.ws?.close();
    // the server has kept the sign-ins by now: the next browser starts clean, from what it puts back
    if (!this.browsers.size) void this.session?.clearStorageData().catch(() => {});
    this.layout();
    this.sync();
  }

  stopAll() {
    void this.finishSignIn(false);
    for (const id of [...this.browsers.keys()]) this.stop(id);
  }

  #dispose(t) {
    for (const w of [this.getWindow(), this.getHost()]) {
      try {
        w?.contentView.removeChildView(t.view);
      } catch {}
    }
    try {
      if (!t.view.webContents.isDestroyed()) t.view.webContents.close();
    } catch {}
  }

  // --- tabs ---------------------------------------------------------------------------------------------------
  async newTab(b, url = "about:blank", activate = true) {
    const view = new WebContentsView({ webPreferences: { session: this.#session(), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const wc = view.webContents;
    const tab = { id: ++this.tabId, view, targetId: null, title: "", loading: false, favicon: "" };
    view.setVisible(false);
    this.getHost().contentView.addChildView(view);
    tab.home = "host";
    // a page that opens another (a sign-in popup, a link to a new window) gets a tab of its own here
    wc.setWindowOpenHandler(({ url }) => {
      void this.newTab(b, url).catch(() => {});
      return { action: "deny" };
    });
    wc.on("page-favicon-updated", (_event, icons) => {
      tab.favicon = icons.find((i) => /^https?:/.test(i)) ?? "";
      this.sync();
    });
    // a page that never stops fetching (a feed) isn't "loading" once its document is up
    wc.on("did-start-navigation", (_e, _url, inPlace, main) => main && !inPlace && (tab.settled = false));
    wc.on("dom-ready", () => ((tab.settled = true), this.#emulate(b), change()));
    const change = () => {
      tab.loading = wc.isLoading() && !tab.settled;
      tab.title = wc.getTitle();
      this.sync();
    };
    for (const event of ["page-title-updated", "did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page"]) wc.on(event, change);
    b.tabs.push(tab);
    tab.targetId = await this.#targetIdOf(wc);
    if (activate) b.active = tab;
    this.layout();
    this.#emulate(b);
    this.sync();
    void wc.loadURL(url).catch(() => {});
    return tab;
  }

  // The id DevTools calls this page by.
  async #targetIdOf(wc) {
    const dbg = wc.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    return (await dbg.sendCommand("Target.getTargetInfo")).targetInfo.targetId;
  }

  #tabByTarget(id) {
    for (const b of this.browsers.values()) {
      const tab = b.tabs.find((t) => t.targetId === id);
      if (tab) return { b, tab };
    }
    return null;
  }

  closeTab(b, tab) {
    const i = b.tabs.indexOf(tab);
    if (i < 0) return;
    b.tabs.splice(i, 1);
    this.#dispose(tab);
    if (b.active === tab) b.active = b.tabs[Math.min(i, b.tabs.length - 1)] ?? null;
    // a browser always has a tab: closing the last one leaves a blank one
    if (!b.tabs.length) void this.newTab(b, "about:blank").catch(() => {});
    this.layout();
    this.sync();
  }

  activate(b, tab) {
    b.active = tab;
    this.layout();
    this.sync();
  }

  // --- what the page of Emplio says: where the pane goes ------------------------------------------------------
  show(spot) {
    this.shown = spot && spot.visible ? spot : null;
    const skin = JSON.stringify(spot?.skin ?? {});
    if (spot?.skin && skin !== this.skin && this.shield && !this.shield.webContents.isDestroyed()) {
      this.skin = skin;
      this.shield.webContents.send("pane:state", { skin: spot.skin });
    }
    this.layout();
    this.sync();
  }

  #current() {
    return this.shown ? [...this.browsers.values()].find((b) => b.chat === this.shown.chat) : undefined;
  }

  layout() {
    const win = this.getWindow();
    const host = this.getHost();
    const b = this.#current();
    const s = this.shown;
    const room = !!win && !win.isDestroyed() && b && s && s.width > 120 && s.height > TOOLBAR + 60;
    for (const other of this.browsers.values()) {
      for (const t of other.tabs) {
        if (room && other === b && t === b.active) continue;
        // not drawn in Emplio's window: it stays in the window nobody sees, at its own size, so it keeps working
        if (t.home !== "host") (host.contentView.addChildView(t.view), (t.home = "host"));
        t.view.setBounds({ x: 0, y: 0, width: other.size.width, height: other.size.height });
        t.view.setVisible(t === other.active);
        this.#emulate(other, other.size.width);
      }
    }
    if (room) {
      const x = Math.round(s.x);
      const y = Math.round(s.y);
      const width = Math.round(s.width);
      const tab = b.active;
      this.#ui().setBounds({ x, y, width, height: TOOLBAR });
      tab?.view.setBounds({ x, y: y + TOOLBAR, width, height: Math.max(0, Math.round(s.height) - TOOLBAR) });
      tab?.view.setVisible(true);
      this.#emulate(b, width);
      // on top of the page, and of the page it's drawn over
      win.contentView.addChildView(this.#ui());
      if (tab) (win.contentView.addChildView(tab.view), (tab.home = "window"));
    }
    if (room || this.ui) this.#ui().setVisible(!!room);
    // only watching: nothing in the page can be clicked or typed in, until Take control
    if (room && !s.control) {
      const shield = this.#shield();
      shield.setBounds({ x: Math.round(s.x), y: Math.round(s.y), width: Math.round(s.width), height: Math.round(s.height) });
      win.contentView.addChildView(shield);
      shield.setVisible(true);
    } else if (this.shield) this.shield.setVisible(false);
  }

  // Emplio's window is going away (Cmd+Q puts the app in the menu bar): what it drew goes, the browsers stay in the host window
  windowGone() {
    for (const v of [this.ui, this.shield]) {
      try {
        if (v && !v.webContents.isDestroyed()) v.webContents.close();
      } catch {}
    }
    this.ui = this.shield = null;
    this.skin = undefined;
    this.shown = null;
    this.layout();
    this.sync();
  }

  #shield() {
    if (this.shield) return this.shield;
    const win = this.getWindow();
    const v = (this.shield = new WebContentsView({ webPreferences: { preload: join(import.meta.dirname, "pane-ui.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } }));
    v.setBackgroundColor("#00000000");
    v.setVisible(false);
    win.contentView.addChildView(v);
    void v.webContents.loadFile(join(import.meta.dirname, "pane-shield.html"));
    // the page's colours, once it is up (and again whenever they change)
    v.webContents.on("did-finish-load", () => this.shown?.skin && v.webContents.send("pane:state", { skin: this.shown.skin }));
    ipcMain.on("pane:act", (event, action) => {
      if (event.sender === v.webContents && action === "take") this.onTake?.();
    });
    return v;
  }

  // Pages are laid out at the browser's own width (1280 unless the browser command set another), not at the width of
  // the panel: the page is zoomed to fit it. So dragging the panel wider doesn't make the site responsive.
  // ponytail: the height follows the panel; zoom is Chromium's, so widths past ~4x the panel's are held at its limit
  #emulate(b, room) {
    if (room) b.room = room;
    if (!b.room) return;
    const zoom = Math.min(5, Math.max(0.25, b.room / b.size.width));
    for (const t of b.tabs) if (!t.view.webContents.isDestroyed()) t.view.webContents.setZoomFactor(zoom);
  }

  // the browser command asked for a page size (null: back to the usual)
  setSize(b, size) {
    b.size = size ? { width: Math.round(size.width), height: Math.round(size.height), mobile: !!size.mobile } : DESKTOP;
    this.layout();
    this.#emulate(b);
  }

  #ui() {
    if (this.ui) return this.ui;
    const win = this.getWindow();
    const ui = (this.ui = new WebContentsView({ webPreferences: { preload: join(import.meta.dirname, "pane-ui.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } }));
    ui.setBackgroundColor("#00000000");
    ui.setVisible(false);
    win.contentView.addChildView(ui);
    void ui.webContents.loadFile(join(import.meta.dirname, "pane-ui.html"));
    ui.webContents.on("did-finish-load", () => this.sync());
    ipcMain.on("pane:act", (event, action, value) => {
      if (event.sender !== ui.webContents) return;
      void this.act(action, value).catch(() => {});
    });
    return ui;
  }

  sync() {
    if (!this.ui || this.ui.webContents.isDestroyed()) return;
    const b = this.#current();
    const tab = b?.active;
    const wc = tab && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
    const url = wc?.getURL() ?? "";
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {}
    this.ui.webContents.send("pane:state", {
      tabs: (b?.tabs ?? []).map((t) => ({ id: t.id, title: t.title, url: t.view.webContents.isDestroyed() ? "" : t.view.webContents.getURL(), active: t === tab, loading: t.loading, favicon: t.favicon })),
      canBack: !!wc?.navigationHistory.canGoBack(),
      canForward: !!wc?.navigationHistory.canGoForward(),
      loading: !!tab?.loading,
      url,
      host,
      signingIn: !!this.signIn,
    });
  }

  async act(action, value) {
    const b = this.#current();
    if (!b) return;
    const tab = b.active;
    const wc = tab?.view.webContents;
    switch (action) {
      case "activate":
        return this.activate(b, b.tabs.find((t) => t.id === value) ?? tab);
      case "close": {
        const t = b.tabs.find((x) => x.id === value);
        return t && this.closeTab(b, t);
      }
      case "new": {
        const t = await this.newTab(b, "about:blank");
        return t.view.webContents.focus();
      }
      case "back":
        return wc?.navigationHistory.goBack();
      case "forward":
        return wc?.navigationHistory.goForward();
      case "reload":
        return wc?.reload();
      case "stop":
        return wc?.stop();
      case "go":
        return void wc?.loadURL(addressOf(value)).catch(() => {});
      case "signin":
        return this.signInWithChrome(b);
      case "cancel-signin":
        return this.finishSignIn(false);
    }
  }

  // --- sign in with the backup Chrome -------------------------------------------------------------------------
  // Google refuses a sign-in inside an app's own browser, so Chrome opens for it, in a window of its own. When the person
  // says they're done, what it signed in (its cookies) is put into this browser, which saves it like any other sign-in.
  // No dialog: the toolbar's button turns into "Done signing in" (and a Cancel), so nothing blocks the app.
  async signInWithChrome(b) {
    if (this.signIn) return this.finishSignIn(true);
    if (this.signingIn) return;
    this.signingIn = true;
    try {
      const exe = this.chromeFor ? await this.chromeFor() : null;
      if (!exe) {
        void dialog.showMessageBox({ type: "info", message: "Chrome isn't ready yet", detail: "Emplio is still getting a copy of Chrome for sign-ins. Try again in a minute.", buttons: ["OK"] });
        return this.#signInOver();
      }
      const current = b.active?.view.webContents.getURL() ?? "";
      const url = /^https?:/.test(current) ? current : "https://accounts.google.com";
      const started = await this.chrome.start({ root: join(b.work, ".."), work: b.work, chat: `signin:${b.chat}`, url });
      const s = (this.signIn = { b, key: started.key, cookies: [], misses: 0, poll: null });
      s.poll = setInterval(async () => {
        if (!this.chrome.open.has(s.key)) return void this.finishSignIn(true);
        const now = await this.#cookiesOf(s.key).catch(() => null);
        if (now) s.misses = 0;
        else if (++s.misses >= 3) return void this.finishSignIn(true); // Chrome closed by the person: it no longer answers
        if (now?.length) s.cookies = now;
      }, 1500);
      this.sync();
    } catch (error) {
      console.error("sign in with Chrome:", error);
      this.#signInOver();
    }
  }

  async finishSignIn(done) {
    const s = this.signIn;
    if (!s) return;
    this.signIn = null;
    clearInterval(s.poll);
    try {
      if (done) {
        const last = await this.#cookiesOf(s.key).catch(() => null);
        await this.#adopt(last?.length ? last : s.cookies);
        for (const t of s.b.tabs) if (!t.view.webContents.isDestroyed()) t.view.webContents.reload();
      }
    } catch (error) {
      console.error("sign in with Chrome:", error);
    } finally {
      this.chrome.stop(s.key);
      this.#signInOver();
    }
  }

  #signInOver() {
    this.signingIn = false;
    this.signIn = null;
    this.sync();
  }

  async #cookiesOf(chromeKey) {
    const { body } = await this.chrome.http(chromeKey, "/json/version");
    const ws = new WebSocket(JSON.parse(body).webSocketDebuggerUrl.replace("ws://__CDP__", `ws://127.0.0.1:${this.chrome.open.get(chromeKey).port}`), { perMessageDeflate: false });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (ws.terminate(), reject(new Error("no answer"))), 5000);
      ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies" })));
      ws.on("message", (data) => {
        clearTimeout(timer);
        const m = JSON.parse(String(data));
        ws.close();
        resolve(m.result?.cookies ?? []);
      });
      ws.on("error", reject);
    });
  }

  async #adopt(cookies) {
    const ses = this.#session();
    for (const c of cookies) {
      const host = c.domain.replace(/^\./, "");
      await ses.cookies
        .set({
          url: `${c.secure ? "https" : "http"}://${host}${c.path || "/"}`,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expires > 0 ? c.expires : undefined,
          sameSite: Object.keys(sameSite).find((k) => sameSite[k] === c.sameSite) ?? "unspecified",
        })
        .catch(() => {});
    }
  }

  // --- DevTools, for whoever drives this browser through the server --------------------------------------------
  #ids(b) {
    return new Set(b.tabs.map((t) => t.targetId));
  }

  async http(id, path) {
    const b = this.browsers.get(id);
    if (!b) throw new Error("no such browser");
    const port = await this.port();
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = (await r.text()).replaceAll(`ws://127.0.0.1:${port}`, "ws://__CDP__").replaceAll(`ws://localhost:${port}`, "ws://__CDP__");
    const body = listPage(path, text, this.#ids(b));
    if (body === null) return { status: 403, body: "{}" };
    return { status: r.status, body };
  }

  async connect({ id, conn, path }, out) {
    const b = this.browsers.get(id);
    if (!b || !allowedPath(path, this.#ids(b))) return out.closed(conn);
    const filter = path.startsWith("/devtools/browser/")
      ? createFilter({
          allowed: () => this.#ids(b),
          createTarget: async ({ url }) => (await this.newTab(b, addressOf(url))).targetId,
          closeTarget: async (targetId) => {
            const found = this.#tabByTarget(targetId);
            if (found) this.closeTab(found.b, found.tab);
          },
          emulate: (size) => this.setSize(b, size),
          activate: (targetId) => {
            const found = this.#tabByTarget(targetId);
            if (found) this.activate(found.b, found.tab);
          },
        })
      : null;
    // registered at once: the server may send before the socket to the browser is open
    const l = { id, ws: null, queued: [], filter, out, closed: false };
    this.links.set(conn, l);
    const port = await this.port().catch(() => 0);
    if (l.closed || !port) return void (this.links.delete(conn), out.closed(conn));
    const ws = (l.ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 }));
    ws.on("open", () => {
      for (const m of l.queued.splice(0)) ws.send(m);
    });
    ws.on("message", (data) => {
      const text = filter ? filter.fromChrome(String(data)) : String(data);
      if (text !== null) out.data(conn, text);
    });
    ws.on("close", () => {
      this.links.delete(conn);
      out.closed(conn);
    });
    ws.on("error", () => ws.close());
  }

  send(conn, data) {
    const l = this.links.get(conn);
    if (!l) return;
    let forward = data;
    if (l.filter) {
      const r = l.filter.fromClient(data);
      if (r.reply) l.out.data(conn, r.reply);
      if (r.later) void r.later.then((text) => l.out.data(conn, text));
      forward = r.forward;
    }
    if (forward === undefined) return;
    if (l.ws?.readyState === WebSocket.OPEN) l.ws.send(forward);
    else l.queued.push(forward);
  }

  close(conn) {
    const l = this.links.get(conn);
    if (!l) return;
    l.closed = true;
    l.ws?.close();
  }
}

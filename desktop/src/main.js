// Emplio for the desktop: the Emplio web app in its own window, and, while it is open and awake, this computer's folder
// and Chrome for Emplio to work with (the server decides when; see backend/src/devices.ts). Close the lid, quit the
// app (Cmd+Q keeps it in the menu bar; "Quit Emplio completely" ends it) or lose the connection and the cloud computer and browser carry on from the last save.
import { rmSync, readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { BrowserWindow, Menu, Notification, Tray, app, autoUpdater, ipcMain, nativeImage, powerMonitor, safeStorage, shell } from "electron";
import { Boxes } from "./box.js";
import { Browsers, fetchChrome, findChrome } from "./chrome.js";
import { Panes } from "./pane.js";
import { overdue } from "./sweep.js";
import { loadConfig } from "./config.js";
import { Link } from "./link.js";
import { Updater } from "./update.js";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const DEFAULT_URL = "https://emplio.app";

if (!app.requestSingleInstanceLock()) app.quit();

// The agent's browser is inside this window (pane.js) and reached over the app's own DevTools port, on this computer only.
// The port is picked by the system and written to a file in the app's folder.
app.commandLine.appendSwitch("remote-debugging-port", "0");
// the DevTools port would make navigator.webdriver true, which some sites take for a robot
app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");
let quitting = false;
// Cmd+Q puts the app in the background (no window, no Dock icon, still in the menu bar and still connected) unless this is set
let fullQuit = false;
// started with the computer, or reopened after an update while it was in the background (set again in whenReady)
let HIDDEN = process.argv.includes("--hidden");
let updater;

const vault = {
  seal: (text) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text).toString("base64") : null),
  open: (text) => {
    try {
      return safeStorage.decryptString(Buffer.from(text, "base64"));
    } catch {
      return null;
    }
  },
};

let config;
let win;
let tray;
let state = "off";
// the app's own data (its key to the server) is out of the commands' sight
const boxes = new Boxes(join(homedir(), "Emplio"), { hide: [app.getPath("userData")] });
const browsers = new Browsers();
// the backup: a Chrome of its own, for what the embedded browser can't do (and for signing in to Google)
// a window nobody sees: the agent's browser lives in it while Emplio's own window is closed or looks at something else
let host;
const hostWindow = () => (host && !host.isDestroyed() ? host : (host = new BrowserWindow({ show: false, width: 1280, height: 900, frame: false, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } })));
const panes = new Panes({
  getWindow: () => (win && !win.isDestroyed() ? win : undefined),
  getHost: hostWindow,
  userData: app.getPath("userData"),
  chrome: browsers,
  chromeFor: async () => findChrome() ?? ((await fetchChrome()), findChrome()),
});
panes.onTake = () => win?.webContents.send("emplio:pane-take");
// which of the two a DevTools connection is to
const driving = new Map();
const whose = (id) => (panes.has(id) ? panes : browsers);

const appUrl = () => new URL(arg("url") ?? process.env.EMPLIO_URL ?? config.appUrl ?? DEFAULT_URL);
const appOrigin = () => appUrl().origin;

// --- what the server may ask of this computer -------------------------------------------------------------
const link = new Link({
  onState: (s) => setState(s),
  // the server gives work only to a computer that says it's a Mac or Windows PC: a PC until its fence holds says otherwise
  platform: () => (boxes.ready ? process.platform : `${process.platform}-getting-ready`),
  handlers: {
    async request(method, p, id) {
      switch (method) {
        case "run":
          return boxes.run(id, p);
        case "write":
          return boxes.write(p);
        case "read":
          return boxes.read(p);
        case "remove":
          return boxes.remove(p);
        case "browser.start": {
          const { root, work } = await boxes.ensure(p);
          // the one built into the app (drawn in its window, or out of sight in the hidden one); Chrome when that can't start or is asked for
          if (p.kind !== "chrome") {
            try {
              let late = false;
              const started = panes.start({ work, chat: p.chat });
              const timer = new Promise((_, no) => setTimeout(() => ((late = true), no(new Error("it took too long"))), 20_000));
              // one that comes up after Chrome took over is closed again
              void started.then((s) => late && panes.stop(s.key)).catch(() => {});
              return await Promise.race([started, timer]);
            } catch (error) {
              console.error("the embedded browser didn't start; using Chrome:", error);
            }
          }
          return browsers.start({ root, work, chat: p.chat });
        }
        case "browser.list":
          return [...panes.list(p.chat), ...browsers.list(p.chat)];
        case "browser.stop":
          return void whose(p.key).stop(p.key);
        case "cdp.http":
          return whose(p.key).http(p.key, p.path);
        case "notify":
          return notify(p);
        default:
          throw new Error(`this version of the app can't do ${method}`);
      }
    },
    note(method, p) {
      if (method === "cancel") boxes.cancel(p.id);
      else if (method === "cdp.open") {
        const to = whose(p.key);
        driving.set(p.conn, to);
        void to.connect(p.path ? { id: p.key, conn: p.conn, path: p.path } : p, {
          data: (conn, data) => link.send({ ev: "cdp.data", conn, data }),
          closed: (conn) => (driving.delete(conn), link.send({ ev: "cdp.closed", conn })),
        });
      } else if (method === "cdp.send") driving.get(p.conn)?.send(p.conn, p.data);
      else if (method === "cdp.close") driving.get(p.conn)?.close(p.conn);
    },
  },
});

// --- notifications ----------------------------------------------------------------------------------------
// The server sends one over the link (backend/src/push.ts decides who gets what); it shows even with the window closed
// and the app in the menu bar. Not when they're looking at that very chat in the focused window.
const shown = new Set(); // kept until clicked or closed, or the system may drop the click
function notify({ title, body, path }) {
  if (!Notification.isSupported()) throw new Error("this computer can't show notifications");
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) throw new Error("bad notification");
  if (win && !win.isDestroyed() && win.isFocused() && win.isVisible() && !win.isMinimized()) {
    try {
      if (new URL(win.webContents.getURL()).pathname === path) return { shown: false };
    } catch {}
  }
  const n = new Notification({ title: String(title ?? "Emplio").slice(0, 100), body: String(body ?? "").slice(0, 300) });
  shown.add(n);
  n.on("click", () => openChat(path));
  n.on("close", () => shown.delete(n));
  n.show();
  console.log("notification shown:", path);
  return { shown: true };
}

// a tapped notification: the window comes up on that chat
function openChat(path) {
  const fresh = !win || win.isDestroyed();
  showWindow(fresh ? path : undefined);
  if (!fresh) win.webContents.send("emplio:open", path);
}

// --- state, menu, tray ------------------------------------------------------------------------------------
const WORDS = {
  off: "Not connected",
  "needs-pairing": "Waiting to connect: sign in to Emplio",
  connecting: "Connecting…",
  online: "Connected: Emplio can use this computer",
};

// The server stops a browser nobody uses (10 minutes). This is for when it can't: it crashed or the link is gone, and
// the pages would stay open (and heavy) until the app quits. So a browser ends at its time limit, and all of them end
// when the server has been out of reach for a quarter of an hour (sweep.js).
let offlineSince = 0;
setInterval(() => {
  const now = Date.now();
  if (state === "online") offlineSince = 0;
  else offlineSince ||= now;
  for (const id of overdue([...panes.browsers], now, offlineSince)) panes.stop(id);
  for (const id of overdue([...browsers.open], now, offlineSince)) browsers.stop(id);
}, 60_000).unref();

function setState(next) {
  state = config.enabled ? next : "off";
  win?.webContents.send("emplio:state", state);
  tray?.setTitle(state === "online" ? "●" : "○");
  buildMenu();
}

function buildMenu() {
  const status = { label: WORDS[state], enabled: false };
  const mine = [status, ...(updater?.ready ? [{ label: "Restart to update", click: () => restart(false) }] : [])];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Emplio", submenu: [{ role: "about" }, { type: "separator" }, ...mine, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { type: "separator" }, { role: "quit" }] },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
  tray?.setContextMenu(Menu.buildFromTemplate([...mine, { type: "separator" }, { label: "Show Emplio", click: showWindow }, { label: "Quit Emplio completely", click: quitCompletely }]));
}

// Quit and reopen as the new version; `hidden`: back in the background, the way it was
function restart(hidden) {
  config.reopenHidden = hidden;
  config.save();
  fullQuit = true;
  // a Mac's updater quits the app itself
  if (updater.apply() && process.platform !== "darwin") app.quit();
}

// Nothing going on: no command running, no browser of Emplio's open, the window not up
const idle = () => !boxes.running.size && !panes.browsers.size && !browsers.open.size && (!win || win.isDestroyed() || !win.isVisible());

function quitCompletely() {
  fullQuit = true;
  app.quit();
}

// Cmd+Q with the computer connected: the window and the browser in it go, the link, the folder's commands and Chrome stay
function intoBackground() {
  const old = win;
  win = undefined;
  panes.windowGone();
  if (old && !old.isDestroyed()) {
    old.webContents.close();
    old.destroy();
  }
  app.dock?.hide();
}

function showWindow(path) {
  app.dock?.show();
  if (!win || win.isDestroyed()) return openWindow(typeof path === "string" ? path : undefined);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openWindow(path = "/login") {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 420,
    minHeight: 600,
    title: "Emplio",
    backgroundColor: "#ffffff",
    // no title bar: the page draws a thin strip to drag the window by (the traffic lights sit in it)
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 22 } } : { titleBarStyle: "hidden", titleBarOverlay: { height: 56 } }),
    webPreferences: { preload: join(import.meta.dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, partition: "persist:emplio-app" },
  });
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} EmplioDesktop`);
  // closing the window puts it away: the browser in it, and the agent's work, carry on
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  // links to other sites open in the person's browser; the app stays on Emplio
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === appOrigin()) return { action: "allow" };
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== appOrigin()) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  void win.loadURL(new URL(path, appUrl()).href).catch(() => {});
  // no internet (or the server is down): a page that says so and comes back by itself (offline.html)
  win.webContents.on("did-fail-load", (_e, code, _text, url, main) => {
    if (main && code !== -3 && url.startsWith("http")) void win.loadFile(join(import.meta.dirname, "offline.html"), { query: { to: url } });
  });
}

// --- the page asks ----------------------------------------------------------------------------------------
// Only the Emplio page itself (the app's own address) may ask, and only to be connected to a server on its own site.
const fromEmplio = (event) => {
  try {
    return new URL(event.senderFrame.url).origin === appOrigin();
  } catch {
    return false;
  }
};
const sameSite = (api, page) => {
  const a = new URL(api);
  const p = new URL(page);
  const local = (h) => h === "localhost" || h === "127.0.0.1";
  const root = (h) => h.split(".").slice(-2).join(".");
  return (local(a.hostname) && local(p.hostname)) || a.hostname === p.hostname || root(a.hostname) === root(p.hostname);
};

ipcMain.handle("emplio:info", (event) => {
  if (!fromEmplio(event)) return null;
  return { installId: config.installId, name: hostname().replace(/\.local$/, ""), platform: process.platform, state, userId: config.userId ?? null, apiUrl: config.apiUrl ?? null };
});

// where the page's browser panel is, so the browser can be drawn over it: { chat, x, y, width, height, visible }
ipcMain.on("emplio:pane", (event, spot) => {
  if (!fromEmplio(event) || typeof spot?.chat !== "string") return;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  panes.show({ chat: spot.chat, x: n(spot.x), y: n(spot.y), width: n(spot.width), height: n(spot.height), visible: spot.visible === true, control: spot.control === true, skin: Object.fromEntries(Object.entries(spot.skin ?? {}).filter(([k, v]) => /^[a-z-]+$/.test(k) && typeof v === "string" && v.length < 80 && !/[;{}]/.test(v))) });
});
// the pane is the page's to ask about: is this the desktop app with a browser of its own
ipcMain.handle("emplio:pane-ready", (event) => fromEmplio(event));

ipcMain.handle("emplio:connect", (event, o) => {
  if (!fromEmplio(event)) throw new Error("not allowed");
  if (!o?.token || typeof o.apiUrl !== "string" || !/^https?:$/.test(new URL(o.apiUrl).protocol) || !sameSite(o.apiUrl, appOrigin())) throw new Error("bad connection details");
  config.token = o.token;
  config.apiUrl = o.apiUrl.replace(/\/$/, "");
  config.userId = o.userId ?? null;
  config.save();
  if (config.enabled) link.start(config.apiUrl, config.token);
  return true;
});

// --- the computer sleeps and wakes ------------------------------------------------------------------------
powerMonitor.on("suspend", () => {
  boxes.stopAll();
  browsers.stopAll();
  panes.stopAll();
  link.pause();
});
powerMonitor.on("resume", () => setTimeout(() => link.resume(), 2000));

// a shutdown or log-out must not be held up by the background mode
powerMonitor.on("shutdown", () => (fullQuit = true));

app.on("before-quit", (event) => {
  if (!fullQuit && config?.enabled && config?.token && state !== "needs-pairing") {
    event.preventDefault();
    intoBackground();
    return;
  }
  quitting = true;
  boxes.stopAll();
  browsers.stopAll();
  panes.stopAll();
});
app.on("window-all-closed", () => {
  // the computer stays available to Emplio from the menu bar, like any app that keeps working in the background
});
app.on("activate", showWindow);
app.on("second-instance", showWindow);

app.whenReady().then(() => {
  const file = join(app.getPath("userData"), "config.json");
  config = loadConfig(file, vault);
  if (arg("url")) config.appUrl = arg("url");
  if (config.reopenHidden !== undefined) {
    HIDDEN = config.reopenHidden;
    delete config.reopenHidden;
    config.save();
  }
  // the app keeps itself up to date (update.js): a new version goes in once nothing is going on
  if (app.isPackaged) {
    updater = new Updater({ api: config.apiUrl ?? "https://api.emplio.app", version: app.getVersion(), onReady: buildMenu, autoUpdater });
    updater.start();
    setInterval(() => updater.ready && idle() && restart(true), 5 * 60_000).unref();
  }
  // a Mac's menu bar shows the tray's title (● / ○); Linux shows only an icon, so it gets the logo
  tray = new Tray(process.platform === "darwin" ? nativeImage.createEmpty() : nativeImage.createFromPath(join(import.meta.dirname, "logo.png")).resize({ width: 22 }));
  tray.setToolTip("Emplio");
  // Chrome profiles of earlier runs hold sign-in cookies and are never reused: clear them
  try {
    const home = join(homedir(), "Emplio");
    for (const w of readdirSync(home)) rmSync(join(home, w, "chrome"), { recursive: true, force: true });
  } catch {}
  // starts with the computer, once (what the person then does in System Settings is left alone)
  if (app.isPackaged && !config.loginSet) {
    app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
    config.loginSet = true;
    config.save();
  }
  if (HIDDEN) app.dock?.hide();
  else openWindow();
  void fetchChrome().then(() => buildMenu());
  // Python for the scripts Emplio keeps (commands work without it meanwhile)
  void boxes.tools.getPython();
  // Windows: Git for Windows and the fence, then the server is told this PC can take work (the link says so as it reconnects)
  const readyUp = () =>
    void boxes.prepare().then(
      () => (link.pause(), link.resume()),
      (error) => (console.error("this PC can't take Emplio's work yet; trying again in 10 minutes:", error), setTimeout(readyUp, 600_000)),
    );
  if (process.platform === "win32") readyUp();
  if (config.token && config.apiUrl && config.enabled) link.start(config.apiUrl, config.token);
  else setState(config.enabled ? "needs-pairing" : "off");
  buildMenu();
});

// the link says needs-pairing when the server no longer knows this computer
export { link };

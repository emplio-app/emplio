// The person's own Chrome (or Edge, Brave, Chromium), started for one chat's browser work and closed after. Each runs on
// a profile folder of its own, thrown away when it closes; the server puts the person's saved sign-ins into it (browser.ts).
// Chrome only listens on this computer; the server reaches it through the app's connection (link.js relays).
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import WebSocket from "ws";

const LOOKING = [
  process.env.EMPLIO_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Arc.app/Contents/MacOS/Arc",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
// Google Chrome that Emplio fetched itself, for a Mac with none of the above (Google's download is universal: Intel or
// Apple chip). The real Chrome, not Chrome for Testing: Google refuses sign-ins from that one, which calls itself plain
// "Chromium". It lives in the app's own folder, so the person's Applications stay as they were.
const SUPPORT = join(homedir(), "Library", "Application Support", "Emplio");
const OWN = join(SUPPORT, "google-chrome");
const OWN_EXE = join(OWN, "Google Chrome.app", "Contents", "MacOS", "Google Chrome");
const DMG_URL = "https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg";
// Google's Apple developer team: the download is used only if it's signed by it
const GOOGLE_TEAM = "EQHXZ8M8AV";
// what Emplio 0.2.1 and older fetched: still used until the real one is here, then deleted
const TESTING = join(SUPPORT, "chrome-for-testing");
const TESTING_EXE = join(TESTING, `chrome-${process.arch === "arm64" ? "mac-arm64" : "mac-x64"}`, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
export const findChrome = () => [...LOOKING, OWN_EXE, TESTING_EXE].find((p) => p && existsSync(p));

const run = (cmd, args) => new Promise((ok, no) => execFile(cmd, args, (e, out, err) => (e ? no(e) : ok(`${out}${err}`))));

// Fetch Google Chrome into our own folder, once, when the app starts; nothing to answer. Until it's there, Chrome for
// Testing (if an earlier version fetched it) or the cloud browser is used.
let fetching = null;
export function fetchChrome() {
  // Chrome needs macOS 12 or newer (Darwin 21): on 11 the cloud browser keeps doing the sign-ins
  if (LOOKING.some((p) => p && existsSync(p)) || existsSync(OWN_EXE) || process.platform !== "darwin" || Number(release().split(".")[0]) < 21)
    return Promise.resolve(false);
  return (fetching ??= (async () => {
    await mkdir(OWN, { recursive: true });
    const dmg = join(OWN, "chrome.dmg");
    const mnt = join(OWN, "mnt");
    const next = join(OWN, "next.app");
    try {
      const res = await fetch(DMG_URL);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dmg));
      await rm(next, { recursive: true, force: true });
      await run("/usr/bin/hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-noautoopen", "-quiet", "-mountpoint", mnt]);
      try {
        await run("/usr/bin/ditto", [join(mnt, "Google Chrome.app"), next]);
      } finally {
        await run("/usr/bin/hdiutil", ["detach", mnt, "-force", "-quiet"]).catch(() => {});
      }
      // not --strict: Google's own disk image already fails it (extended attributes on some helpers)
      await run("/usr/bin/codesign", ["--verify", "--deep", next]);
      if (!(await run("/usr/bin/codesign", ["-dv", next])).includes(`TeamIdentifier=${GOOGLE_TEAM}`)) throw new Error("not signed by Google");
      await rename(next, join(OWN, "Google Chrome.app"));
      await rm(TESTING, { recursive: true, force: true });
      return true;
    } finally {
      await rm(dmg, { force: true });
      await rm(next, { recursive: true, force: true });
    }
  })().catch((e) => (console.error("chrome not fetched:", e), (fetching = null), false)));
}

const HOURS = 4;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const key = () => Math.random().toString(36).slice(2, 8).padEnd(6, "0");

export class Browsers {
  // work: where a box's /work really is, so downloads land in its /work/tmp/downloads
  constructor() {
    this.open = new Map();
    this.links = new Map();
  }

  async start({ root, work, chat, url = "about:blank" }) {
    const exe = findChrome();
    if (!exe) throw new Error("no Chrome, Edge or Brave on this computer");
    const id = key();
    const profile = join(root, "chrome", id);
    await mkdir(join(profile, "Default"), { recursive: true });
    await mkdir(join(work, "tmp", "downloads"), { recursive: true });
    await writeFile(
      join(profile, "Default", "Preferences"),
      JSON.stringify({ download: { default_directory: join(work, "tmp", "downloads"), prompt_for_download: false }, profile: { exit_type: "Normal" } }),
    );
    const child = spawn(
      exe,
      [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-allow-origins=*", "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
        // a debugging port alone makes navigator.webdriver true, and Google then refuses the sign-in
        "--disable-blink-features=AutomationControlled", url],
      { stdio: "ignore", detached: false },
    );
    const b = { id, chat, child, profile, port: 0, startedAt: new Date(), timeoutAt: new Date(Date.now() + HOURS * 3_600_000) };
    child.on("exit", () => this.#gone(b));
    // Chrome writes its port to this file once it listens
    const file = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 80 && !b.port; i++) {
      await wait(250);
      if (b.closed) throw new Error("the browser closed as it started");
      b.port = Number((await readFile(file, "utf8").catch(() => "")).split("\n")[0]) || 0;
    }
    if (!b.port) {
      this.stop(id);
      throw new Error("the browser didn't start");
    }
    this.open.set(id, b);
    return { key: id, startedAt: b.startedAt.toISOString(), timeoutAt: b.timeoutAt.toISOString() };
  }

  list(chat) {
    return [...this.open.values()].filter((b) => b.chat === chat).map((b) => ({ key: b.id, startedAt: b.startedAt.toISOString(), timeoutAt: b.timeoutAt.toISOString() }));
  }

  stop(id) {
    const b = this.open.get(id);
    if (!b) return;
    this.#gone(b);
    b.child.kill("SIGTERM");
    setTimeout(() => b.child.kill("SIGKILL"), 3000).unref();
  }

  stopAll() {
    for (const id of [...this.open.keys()]) this.stop(id);
  }

  #gone(b) {
    b.closed = true;
    this.open.delete(b.id);
    for (const [conn, l] of this.links) if (l.id === b.id) l.ws.close();
    // the folder goes once Chrome has let go of it
    setTimeout(() => void rm(b.profile, { recursive: true, force: true }).catch(() => {}), 2000).unref();
  }

  // Chrome's /json/... pages, with its own address replaced by a marker the server swaps for its own
  async http(id, path) {
    const b = this.open.get(id);
    if (!b) throw new Error("no such browser");
    const r = await fetch(`http://127.0.0.1:${b.port}${path}`);
    const body = (await r.text()).replaceAll(`ws://127.0.0.1:${b.port}`, "ws://__CDP__").replaceAll(`ws://localhost:${b.port}`, "ws://__CDP__");
    return { status: r.status, body };
  }

  // A DevTools socket for someone driving this browser through the server: `send` goes to Chrome, what Chrome says goes to `out`.
  connect({ id, conn, path }, out) {
    const b = this.open.get(id);
    if (!b) return out.closed(conn);
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}${path}`, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    const queued = [];
    ws.on("open", () => {
      for (const m of queued.splice(0)) ws.send(m);
    });
    ws.on("message", (data) => out.data(conn, String(data)));
    ws.on("close", () => {
      this.links.delete(conn);
      out.closed(conn);
    });
    ws.on("error", () => ws.close());
    this.links.set(conn, { id, ws, queued });
  }

  send(conn, data) {
    const l = this.links.get(conn);
    if (!l) return;
    if (l.ws.readyState === WebSocket.OPEN) l.ws.send(data);
    else l.queued.push(data);
  }

  close(conn) {
    this.links.get(conn)?.ws.close();
  }
}

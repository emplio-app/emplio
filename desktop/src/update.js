// Keeps the app itself up to date. The server says what the newest version is (cloud: GET /desktop/update/<kind>);
// a newer one is fetched in the background and put in place the next time nothing is going on (main.js).
// A Mac uses macOS's own updater (Squirrel, built into Electron: it checks the new app is signed by us, swaps it in and
// reopens it). Windows and Linux have no such thing for a plain folder, so the new folder is fetched next to this one,
// checked against its SHA-256, and swapped in by a small script once the app has quit.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { access, constants, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { run } from "./tools.js";

const HOURS = 6;

// which build this is: the Mac's has two (macOS 11 and 12 get an older Electron, desktop `npm run pack:older`)
export function kind(platform = process.platform, electron = process.versions.electron) {
  if (platform === "darwin") return Number(electron.split(".")[0]) < 40 ? "darwin-older" : "darwin";
  return platform === "win32" || platform === "linux" ? platform : null;
}

export const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v).split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

// The script that swaps the folders once this app (pid) has quit, then opens the new one
export function swapScript(platform, { pid, install, fresh, open }) {
  const old = `${install}.old`;
  if (platform === "win32") {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    return `$ErrorActionPreference = 'Stop'
Wait-Process -Id ${pid} -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Remove-Item -LiteralPath ${q(old)} -Recurse -Force -ErrorAction SilentlyContinue
$moved = $false
for ($i = 0; $i -lt 30 -and -not $moved; $i++) { try { Move-Item -LiteralPath ${q(install)} -Destination ${q(old)}; $moved = $true } catch { Start-Sleep -Seconds 1 } }
if ($moved) { try { Move-Item -LiteralPath ${q(fresh)} -Destination ${q(install)} } catch { Move-Item -LiteralPath ${q(old)} -Destination ${q(install)} } }
Start-Process -FilePath ${q(open)}
Remove-Item -LiteralPath ${q(old)} -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath ${q(dirname(fresh))} -Recurse -Force -ErrorAction SilentlyContinue
`;
  }
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done
rm -rf ${q(old)}
if mv ${q(install)} ${q(old)}; then mv ${q(fresh)} ${q(install)} || mv ${q(old)} ${q(install)}; fi
nohup ${q(open)} >/dev/null 2>&1 &
rm -rf ${q(old)} ${q(dirname(fresh))}
`;
}

export class Updater {
  // api: the Emplio server; onReady(): a new version is waiting to be put in place; autoUpdater: Electron's (the Mac's)
  constructor({ api, version, onReady, autoUpdater }) {
    this.api = api;
    this.mac = autoUpdater;
    this.version = version;
    this.onReady = onReady;
    this.ready = false;
    this.busy = false;
    this.kind = kind();
  }

  start() {
    if (!this.kind) return;
    if (process.platform === "darwin") {
      this.mac.on("error", (error) => console.error("update failed:", error.message));
      this.mac.on("update-downloaded", () => this.#done());
    }
    const check = () => void this.check().catch((error) => console.error("update check failed:", error.message));
    setTimeout(check, 60_000);
    setInterval(check, HOURS * 3_600_000).unref();
  }

  feed = () => `${this.api}/desktop/update/${this.kind}?version=${encodeURIComponent(this.version)}`;

  async check() {
    if (this.ready || this.busy) return;
    if (process.platform === "darwin") {
      // Squirrel asks the same address, and fetches and checks the app itself
      this.mac.setFeedURL({ url: this.feed() });
      return this.mac.checkForUpdates();
    }
    const r = await fetch(this.feed());
    if (r.status === 204) return;
    if (!r.ok) throw new Error(`${r.status}`);
    const info = await r.json();
    if (!newer(info.name, this.version)) return;
    this.busy = true;
    try {
      await this.#fetch(info);
    } finally {
      this.busy = false;
    }
  }

  // The new folder, fetched and unpacked beside this one (it must be there for the swap to be a quick rename)
  async #fetch(info) {
    this.install = dirname(process.execPath);
    const parent = dirname(this.install);
    try {
      await access(parent, constants.W_OK);
    } catch {
      return console.error(`can't update: ${parent} isn't writable`);
    }
    const stage = join(parent, ".emplio-update");
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    const r = await fetch(info.url);
    if (!r.ok) throw new Error(`${r.status}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== info.sha256) throw new Error("the download isn't the one expected");
    const file = join(stage, process.platform === "win32" ? "app.zip" : "app.tar.gz");
    await writeFile(file, bytes);
    // Windows' own tar unpacks a zip too
    await run(process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar", ["-xf", file, "-C", stage], { timeout: 600_000 });
    await rm(file);
    const top = (await readdir(stage)).find((d) => !d.startsWith("."));
    if (!top || !existsSync(join(stage, top, basename(process.execPath)))) throw new Error("the download has no app in it");
    this.fresh = join(stage, top);
    this.#done();
  }

  #done() {
    if (this.ready) return;
    this.ready = true;
    this.onReady?.();
  }

  // Quit and come back as the new version (main.js remembers whether it was in the background). The caller lets the app quit.
  apply() {
    if (!this.ready) return false;
    if (process.platform === "darwin") {
      this.mac.quitAndInstall();
      return true;
    }
    const open = process.platform === "win32" ? process.execPath : join(this.install, "emplio");
    const script = swapScript(process.platform, { pid: process.pid, install: this.install, fresh: this.fresh, open });
    const file = join(dirname(this.fresh), process.platform === "win32" ? "swap.ps1" : "swap.sh");
    // written before the app quits, so not async
    writeFileSync(file, script);
    const child =
      process.platform === "win32"
        ? spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], { detached: true, stdio: "ignore", windowsHide: true })
        : spawn("/bin/sh", [file], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  }
}

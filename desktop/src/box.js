// The person's computer for one business: a folder (~/Emplio/<business>/) that stands in for Emplio's /work, and the
// commands Emplio runs in it. The commands run as the person but fenced in: they can write only inside that folder
// (and the system's scratch space), and can't read the person's keys, browser data or personal folders. Their home is
// the folder's own `home`, so tools' settings (git's, say) never touch the person's real ones.
// On a Mac the fence is sandbox-exec; on Windows, Low integrity (fence-win.js), with Git for Windows' bash.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fenceHolds, fenceTest, hiddenOnWindows, HIDDEN, label, LOW_FILE, LOW_TREE } from "./fence-win.js";
import { folderName, localPath, shellPath, toLocal, toRemote } from "./paths.js";
import { Tools } from "./tools.js";

const WIN = process.platform === "win32";
const MAX_OUTPUT = 20 * 1024 * 1024;
const q = (p) => `"${String(p).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// What a command may touch. Writes: only the business folder, the system's scratch space and /dev. Reads: everything
// except what keeps the person's secrets or personal files (those need to be put in the Emplio folder to be seen).
export function sandboxProfile(root, home = homedir()) {
  const hidden = [
    ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config/gcloud", ".azure", ".netrc", ".npmrc", ".zsh_history", ".bash_history",
    "Library/Keychains", "Library/Cookies", "Library/Safari", "Library/Messages", "Library/Mail", "Library/Application Support/Google", "Library/Application Support/BraveSoftware",
    "Library/Application Support/Firefox", "Library/Application Support/Microsoft Edge", "Library/Application Support/Emplio", "Library/Application Support/AddressBook",
    "Desktop", "Documents", "Downloads", "Pictures", "Movies", "Music",
  ];
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${q(root)}) (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/dev"))`,
    `(deny file-read* ${hidden.map((h) => `(subpath ${q(join(home, h))})`).join(" ")})`,
    // the folder itself is always readable, even where it sits under a hidden one
    `(allow file-read* (subpath ${q(root)}))`,
  ].join("\n");
}

// What Linux has that the computer doesn't, which Emplio's commands use. perl comes with every Mac. On Windows a
// process group is no use, `python3` is `python`, and Python (and cmd) can't run the bash `emplio` without help.
const SHIMS = WIN
  ? (tools) => ({
      setsid: `#!/bin/sh\nexec "$@"\n`,
      python3: `#!/bin/sh\nexec python "$@"\n`,
      "emplio.cmd": `@"${tools.bash()}" "%~dp0emplio" %*\r\n`,
      "ez.cmd": `@"${tools.bash()}" "%~dp0emplio" %*\r\n`,
    })
  : () => ({
      setsid: `#!/bin/sh\nexec /usr/bin/perl -e 'use POSIX; POSIX::setsid(); exec @ARGV or die "setsid: $!"' -- "$@"\n`,
      timeout: `#!/bin/sh\nt="$1"; shift\nexec /usr/bin/perl -e 'alarm shift; exec @ARGV or die "timeout: $!"' -- "$t" "$@"\n`,
    });

// What Windows programs need from the environment to start at all
const WIN_KEEP = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "CommonProgramFiles", "CommonProgramFiles(x86)", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "PUBLIC"];

export class Boxes {
  // hide: more folders commands may not read (the app's own data); Windows only, the Mac's list is above
  constructor(base, { hide = [] } = {}) {
    this.base = base;
    this.roots = new Map();
    this.running = new Map();
    this.tools = new Tools(join(base, ".tools"));
    this.hide = hide;
    this.fenced = null;
    this.ready = !WIN;
  }

  // Windows: Git for Windows fetched, the fence set up and proven. Until it holds this computer takes no work
  // (main.js tells the server). Tried again on the next call after a failure.
  prepare() {
    if (!WIN) return Promise.resolve(true);
    return (this.fenced ??= (async () => {
      if (!(await this.tools.getGit())) throw new Error("Git for Windows couldn't be fetched");
      await this.tools.getPython();
      const test = join(this.base, ".fence-test");
      for (const d of ["home", "tmp"]) await mkdir(join(test, d), { recursive: true });
      // once: a big Documents folder takes a while to label, and what's put in it later inherits the label
      const once = join(this.tools.dir, ".hidden-v1");
      if (!existsSync(once)) {
        await label([...hiddenOnWindows(), ...this.hide].map((p) => [p, HIDDEN]));
        await writeFile(once, "");
      }
      await label([
        [this.tools.bash(), LOW_FILE],
        [test, LOW_TREE],
      ]);
      const secret = join(this.hide[0] ?? test, "config.json");
      const r = await this.#spawn({ root: test }, fenceTest(secret, join(this.base, ".fence-escaped")), test, this.env(test, {}, shellPath(test)), 60_000);
      if (!fenceHolds(r.out)) throw new Error(`the fence didn't hold: ${r.out}`);
      this.ready = true;
      return true;
    })().catch((error) => {
      this.fenced = null;
      throw error;
    }));
  }

  // The folder for a business, made on first use: { root, work, shell }
  async ensure({ box, name }) {
    const key = `${box}`;
    const known = this.roots.get(key);
    if (known) return known;
    // a business keeps the folder it first got, even if it is renamed or the browser asks for it before a name is known
    await mkdir(this.base, { recursive: true });
    const mine = folderName(box, "x").slice(-8);
    const had = (await readdir(this.base).catch(() => [])).find((d) => d.endsWith(`-${mine}`));
    const made = join(this.base, had ?? folderName(box, name));
    for (const d of ["work/in", "work/out", "work/tmp", "home", "bin", "tmp"]) await mkdir(join(made, d), { recursive: true });
    const root = await realpath(made);
    if (WIN) {
      await this.prepare();
      // its own scratch space too (TEMP is in here): everything a command may write
      if (!existsSync(join(root, ".fenced"))) await label([[root, LOW_TREE]]).then(() => writeFile(join(root, ".fenced"), ""));
    }
    for (const [file, text] of Object.entries(SHIMS(this.tools))) {
      await writeFile(join(root, "bin", file), text);
      await chmod(join(root, "bin", file), 0o755);
    }
    if (!WIN) await mkdir(`/private/tmp/emplio-ab-${process.getuid?.() ?? 0}`, { recursive: true, mode: 0o700 });
    const work = join(root, "work");
    const entry = { root, work, shell: WIN ? shellPath(work) : work };
    this.roots.set(key, entry);
    return entry;
  }

  env(root, given = {}, shell) {
    const mapped = Object.fromEntries(Object.entries(given).map(([k, v]) => [k, toLocal(v, shell)]));
    const python = this.tools.hasPython() ? [this.tools.pythonBin(), ...(WIN ? [join(this.tools.pythonBin(), "Scripts")] : [])] : [];
    const common = { HOME: join(root, "home"), LANG: "en_US.UTF-8", TERM: "dumb", GIT_TERMINAL_PROMPT: "0" };
    if (WIN) {
      const home = join(root, "home");
      const git = this.tools.git;
      return {
        ...Object.fromEntries(WIN_KEEP.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))),
        PATH: [join(root, "bin"), ...python, join(git, "mingw64", "bin"), join(git, "usr", "bin"), process.env.PATH ?? process.env.Path ?? ""].join(";"),
        ...common,
        USERPROFILE: home,
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
        TEMP: join(root, "tmp"),
        TMP: join(root, "tmp"),
        MSYSTEM: "MINGW64",
        CHERE_INVOKING: "1",
        ...mapped,
      };
    }
    return {
      PATH: [join(root, "bin"), ...python, "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"].join(":"),
      USER: process.env.USER ?? "",
      // agent-browser keeps a socket in here; the default (under HOME) is too long for a Mac (104 bytes)
      AGENT_BROWSER_SOCKET_DIR: `/private/tmp/emplio-ab-${process.getuid?.() ?? 0}`,
      ...common,
      ...mapped,
    };
  }

  // The folder's paths, in whatever form a program wrote them, as /work again
  back(text, { work, shell }) {
    let t = toRemote(text, shell);
    if (WIN) t = toRemote(toRemote(t, work), work.replace(/\\/g, "/"));
    return t;
  }

  // One command. Like the cloud computer: stdout and stderr together, a timeout is exit code 124.
  async run(id, p) {
    const entry = await this.ensure(p);
    // the server starts in /work (setup uses "/", which this computer has no use for)
    const cwd = String(p.cwd ?? "").startsWith("/work") ? localPath(entry.work, p.cwd) : entry.work;
    const command = toLocal(p.command, entry.shell);
    const r = await this.#spawn(entry, command, cwd, this.env(entry.root, p.env, entry.shell), p.timeoutMs, id);
    if (r.why === "timeout") return { exitCode: 124, result: `Command timed out after ${Math.round(p.timeoutMs / 1000)}s` };
    return { exitCode: r.code, result: this.back(r.out, entry) };
  }

  async #spawn({ root }, command, cwd, env, timeoutMs, id) {
    let child;
    let file;
    if (WIN) {
      // in a file: no quoting to survive between Node, Windows and bash. bash.exe is labelled Low, so it and all it starts run at Low
      file = join(root, "tmp", `.command-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
      await writeFile(file, command);
      child = spawn(this.tools.bash(), ["--noprofile", "--norc", file], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } else child = spawn("/usr/bin/sandbox-exec", ["-p", sandboxProfile(root), "/bin/bash", "-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = Buffer.alloc(0);
    const take = (chunk) => {
      if (out.length < MAX_OUTPUT) out = Buffer.concat([out, chunk]);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let why = null;
    const stop = (reason) => {
      why ??= reason;
      if (WIN) execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      else
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    };
    if (id !== undefined) this.running.set(id, () => stop("stopped"));
    const timer = timeoutMs ? setTimeout(() => stop("timeout"), timeoutMs) : undefined;
    const code = await new Promise((done) => {
      child.on("error", (error) => {
        out = Buffer.from(`could not start the command: ${error.message}`);
        done(127);
      });
      child.on("close", (c, signal) => done(c ?? (signal ? 128 : 1)));
    });
    clearTimeout(timer);
    if (id !== undefined) this.running.delete(id);
    if (file) await rm(file, { force: true }).catch(() => {});
    return { code, out: out.toString("utf8"), why };
  }

  cancel(id) {
    this.running.get(id)?.();
  }

  // Everything still running, stopped (the computer is going to sleep, or the app is closing)
  stopAll() {
    for (const stop of this.running.values()) stop();
  }

  // The server's /work path (or the folder's own, as a command printed it) as a real one
  #path(entry, p) {
    return localPath(entry.work, this.back(p, entry));
  }

  async write(p) {
    const entry = await this.ensure(p);
    const file = this.#path(entry, p.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(p.b64, "base64"));
    return {};
  }

  async read(p) {
    const entry = await this.ensure(p);
    return { b64: (await readFile(this.#path(entry, p.path))).toString("base64") };
  }

  async remove(p) {
    const entry = await this.ensure(p);
    await rm(this.#path(entry, p.path), { recursive: true, force: true });
    return {};
  }
}

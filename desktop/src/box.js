// The person's computer for one business: a folder (~/Emplio/<business>/) that stands in for Emplio's /work, and the
// commands Emplio runs in it. The commands run as the person but fenced in: they can write only inside that folder
// (and the system's scratch space), and can't read the person's keys, browser data or personal folders. Their home is
// the folder's own `home`, so tools' settings (git's, say) never touch the person's real ones.
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { folderName, localPath, toLocal, toRemote } from "./paths.js";

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

// Two things Linux has that a Mac doesn't, which Emplio's commands use. perl comes with every Mac.
const SHIMS = {
  setsid: `#!/bin/sh\nexec /usr/bin/perl -e 'use POSIX; POSIX::setsid(); exec @ARGV or die "setsid: $!"' -- "$@"\n`,
  timeout: `#!/bin/sh\nt="$1"; shift\nexec /usr/bin/perl -e 'alarm shift; exec @ARGV or die "timeout: $!"' -- "$t" "$@"\n`,
};

export class Boxes {
  constructor(base) {
    this.base = base;
    this.roots = new Map();
    this.running = new Map();
  }

  // The folder for a business, made on first use: { root, work }
  async ensure({ box, name }) {
    const key = `${box}`;
    const known = this.roots.get(key);
    if (known) return known;
    // a business keeps the folder it first got, even if it is renamed or the browser asks for it before a name is known
    await mkdir(this.base, { recursive: true });
    const mine = folderName(box, "x").slice(-8);
    const had = (await readdir(this.base).catch(() => [])).find((d) => d.endsWith(`-${mine}`));
    const made = join(this.base, had ?? folderName(box, name));
    for (const d of ["work/in", "work/out", "work/tmp", "home", "bin"]) await mkdir(join(made, d), { recursive: true });
    const root = await realpath(made);
    for (const [file, text] of Object.entries(SHIMS)) {
      await writeFile(join(root, "bin", file), text);
      await chmod(join(root, "bin", file), 0o755);
    }
    await mkdir(`/private/tmp/emplio-ab-${process.getuid?.() ?? 0}`, { recursive: true, mode: 0o700 });
    const entry = { root, work: join(root, "work") };
    this.roots.set(key, entry);
    return entry;
  }

  env(root, given = {}, work) {
    const mapped = Object.fromEntries(Object.entries(given).map(([k, v]) => [k, toLocal(v, work)]));
    return {
      PATH: `${join(root, "bin")}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: join(root, "home"),
      USER: process.env.USER ?? "",
      // agent-browser keeps a socket in here; the default (under HOME) is too long for a Mac (104 bytes)
      AGENT_BROWSER_SOCKET_DIR: `/private/tmp/emplio-ab-${process.getuid?.() ?? 0}`,
      LANG: "en_US.UTF-8",
      TERM: "dumb",
      GIT_TERMINAL_PROMPT: "0",
      ...mapped,
    };
  }

  // One command. Like the cloud computer: stdout and stderr together, a timeout is exit code 124.
  async run(id, p) {
    const { root, work } = await this.ensure(p);
    // the server starts in /work (setup uses "/", which a Mac has no use for)
    const cwd = String(p.cwd ?? "").startsWith("/work") ? localPath(work, p.cwd) : work;
    const command = toLocal(p.command, work);
    const child = spawn("/usr/bin/sandbox-exec", ["-p", sandboxProfile(root), "/bin/bash", "-c", command], {
      cwd,
      env: this.env(root, p.env, work),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = Buffer.alloc(0);
    const take = (chunk) => {
      if (out.length < MAX_OUTPUT) out = Buffer.concat([out, chunk]);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let why = null;
    const stop = (reason) => {
      why ??= reason;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    this.running.set(id, () => stop("stopped"));
    const timer = p.timeoutMs ? setTimeout(() => stop("timeout"), p.timeoutMs) : undefined;
    const code = await new Promise((done) => {
      child.on("error", (error) => {
        out = Buffer.from(`could not start the command: ${error.message}`);
        done(127);
      });
      child.on("close", (c, signal) => done(c ?? (signal ? 128 : 1)));
    });
    clearTimeout(timer);
    this.running.delete(id);
    const text = toRemote(out.toString("utf8"), work);
    if (why === "timeout") return { exitCode: 124, result: `Command timed out after ${Math.round(p.timeoutMs / 1000)}s` };
    return { exitCode: code, result: text };
  }

  cancel(id) {
    this.running.get(id)?.();
  }

  // Everything still running, stopped (the computer is going to sleep, or the app is closing)
  stopAll() {
    for (const stop of this.running.values()) stop();
  }

  async write(p) {
    const { work } = await this.ensure(p);
    const file = localPath(work, p.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(p.b64, "base64"));
    return {};
  }

  async read(p) {
    const { work } = await this.ensure(p);
    return { b64: (await readFile(localPath(work, p.path))).toString("base64") };
  }

  async remove(p) {
    const { work } = await this.ensure(p);
    await rm(localPath(work, p.path), { recursive: true, force: true });
    return {};
  }
}

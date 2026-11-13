// Tools Emplio's commands need that a fresh computer may lack, fetched once into ~/Emplio/.tools (beside the businesses'
// folders: commands can use them but not change them). Python everywhere, since every script Emplio keeps is Python so
// it runs on any computer (a fresh Mac's python3 only offers to install Apple's developer tools). On Windows, Git for
// Windows too: bash, git and the usual Unix tools, which Emplio's own commands are written in.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PY_AT = "https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.12.16+20261026-";
const PYTHON = {
  "darwin-arm64": ["aarch64-apple-darwin", "353d5f1b4fd2715e7053f12f068435d5bbad16b91e057006b5d01e0925709a7e"],
  "darwin-x64": ["x86_64-apple-darwin", "37c38fda76fec1fbf310adcbafb7f0d96af13b5511bf8ea954c3aa8eec185734"],
  "win32-x64": ["x86_64-pc-windows-msvc", "1f2ab53880fc67ea323398c6388e05af28addc99a8e389209f08a51fdff4b149"],
};
const GIT = {
  url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe",
  sha: "b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1",
};

export const run = (file, args, o = {}) =>
  new Promise((ok, no) =>
    execFile(file, args, { windowsHide: true, maxBuffer: 16 << 20, ...o }, (e, out, err) => (e ? no(new Error(`${file} ${args[0] ?? ""}: ${String(err || e.message).trim()}`)) : ok(String(out)))),
  );

async function fetchChecked(url, sha, to) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== sha) throw new Error(`${url} isn't the file expected`);
  await writeFile(to, bytes);
}

export class Tools {
  constructor(dir) {
    this.dir = dir;
    this.python = join(dir, "python-3.12.16");
    this.git = join(dir, "git-2.56.0.4");
    this.fetching = {};
  }

  // Where each is once fetched (made in a scratch folder and moved in whole, so a half-done one is never used)
  pythonBin = () => (process.platform === "win32" ? this.python : join(this.python, "bin"));
  hasPython = () => existsSync(join(this.pythonBin(), process.platform === "win32" ? "python.exe" : "python3"));
  bash = () => join(this.git, "usr", "bin", "bash.exe");
  hasGit = () => existsSync(this.bash());

  // Each fetched once, however many ask at the same time; a failure is tried again next time
  getPython() {
    const kind = PYTHON[`${process.platform}-${process.arch}`];
    if (!kind || this.hasPython()) return Promise.resolve(this.hasPython());
    return (this.fetching.python ??= this.#unpack(this.python, async (tmp) => {
      const file = join(tmp, "python.tar.gz");
      await fetchChecked(`${PY_AT}${kind[0]}-install_only_stripped.tar.gz`, kind[1], file);
      await run(process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar", ["-xzf", file, "-C", tmp]);
      return join(tmp, "python");
    }).finally(() => (this.fetching.python = null)));
  }

  getGit() {
    if (process.platform !== "win32" || this.hasGit()) return Promise.resolve(this.hasGit());
    return (this.fetching.git ??= this.#unpack(this.git, async (tmp) => {
      const file = join(tmp, "git.7z.exe");
      await fetchChecked(GIT.url, GIT.sha, file);
      // Git for Windows' portable copy unpacks itself, silently with -y
      await run(file, [`-o${join(tmp, "git")}`, "-y"], { timeout: 600_000 });
      return join(tmp, "git");
    }).finally(() => (this.fetching.git = null)));
  }

  async #unpack(dest, make) {
    await mkdir(this.dir, { recursive: true });
    const tmp = await mkdtemp(join(this.dir, ".fetching-"));
    try {
      await rename(await make(tmp), dest);
      return true;
    } catch (error) {
      console.error(`fetching ${dest} failed:`, error);
      return false;
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
}

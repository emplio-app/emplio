import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncFiles } from "./file-index";

// Gitea holds the agent's files: one org per workspace, with `company`, `restricted` and one
// `me-<userId>` repo per person. This server is its only client.
//
// Sandboxes never talk to Gitea themselves, so commits travel
// as git bundles: this server keeps a throwaway bare mirror per repo, bundles what a box is missing,
// and pushes what a box committed. The git credential never enters a sandbox.
const GITEA = process.env.GITEA_URL!;
const TOKEN = process.env.GITEA_TOKEN ?? "";
const MIRRORS = join(tmpdir(), "employee0-git");
const AUTH_HEADER = `Authorization: Basic ${Buffer.from(`employee0:${TOKEN}`).toString("base64")}`;

async function gitea(path: string, init?: RequestInit) {
  return fetch(`${GITEA}/api/v1${path}`, {
    ...init,
    headers: { authorization: `token ${TOKEN}`, "content-type": "application/json", ...init?.headers },
  });
}

// Who is saving, the address GitHub keeps for them (what their own git commits name, git-proxy.ts githubAddress), and
// (staff in company files) the only paths they may change.
export type Pusher = { email: string; github?: string | null; only?: RegExp };

export const orgFor = (workspaceId: string) => `ws-${workspaceId}`;

const ensured = new Set<string>();

// Create the workspace org and repo on first use. Each repo starts with a README so it has a main branch.
export async function ensureRepo(workspaceId: string, repo: string, description: string) {
  const org = orgFor(workspaceId);
  const key = `${org}/${repo}`;
  if (ensured.has(key)) return;
  if ((await gitea(`/repos/${key}`)).status === 404) {
    if ((await gitea(`/orgs/${org}`)).status === 404) {
      const res = await gitea("/orgs", { method: "POST", body: JSON.stringify({ username: org, visibility: "private" }) });
      if (!res.ok && res.status !== 422) throw new Error(`gitea: create org failed (${res.status})`);
    }
    const res = await gitea(`/orgs/${org}/repos`, {
      method: "POST",
      body: JSON.stringify({ name: repo, description, private: true, auto_init: true, default_branch: "main" }),
    });
    if (!res.ok && res.status !== 409) throw new Error(`gitea: create repo failed (${res.status})`);
  }
  ensured.add(key);
}

// One file from a repo's main branch, or null when it isn't there.
export async function readFile(workspaceId: string, repo: string, path: string) {
  const res = await gitea(`/repos/${orgFor(workspaceId)}/${repo}/raw/${path}?ref=main`);
  return res.ok ? res.text() : null;
}

export async function createFile(workspaceId: string, repo: string, path: string, content: string, message: string) {
  const res = await gitea(`/repos/${orgFor(workspaceId)}/${repo}/contents/${path}`, {
    method: "POST",
    body: JSON.stringify({ content: Buffer.from(content).toString("base64"), message, branch: "main" }),
  });
  // 422: another request created it first
  if (!res.ok && res.status !== 422) throw new Error(`gitea: create ${path} failed (${res.status})`);
  indexLater(workspaceId, repo);
}

type Author = { name: string; email: string };

// The files in one folder of main (not recursive), with their blob sha; empty when the folder isn't there.
export async function listFolder(workspaceId: string, repo: string, path: string): Promise<{ name: string; sha: string }[]> {
  const res = await gitea(`/repos/${orgFor(workspaceId)}/${repo}/contents/${path}?ref=main`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`gitea: list ${path} failed (${res.status})`);
  return ((await res.json()) as { type: string; name: string; sha: string }[]).filter((f) => f.type === "file");
}

// Every file path on main (recursive). ponytail: one page of Gitea's tree listing; page it if repos outgrow that
export async function listPaths(workspaceId: string, repo: string): Promise<{ path: string; sha: string; size: number }[]> {
  const res = await gitea(`/repos/${orgFor(workspaceId)}/${repo}/git/trees/main?recursive=true&per_page=10000`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`gitea: list ${repo} failed (${res.status})`);
  return ((await res.json()) as { tree: { path: string; type: string; sha: string; size: number }[] }).tree
    .filter((t) => t.type === "blob")
    .map((t) => ({ path: t.path, sha: t.sha, size: t.size }));
}

// A file's blob sha on main, or null when it isn't there.
async function shaOf(workspaceId: string, repo: string, path: string) {
  const res = await gitea(`/repos/${orgFor(workspaceId)}/${repo}/contents/${path}?ref=main`);
  return res.ok ? ((await res.json()) as { sha: string }).sha : null;
}

// Every commit to main comes through here (a box's push, or a server write), so the search copy follows from
// these. Never waits or fails the commit: a missed one is caught up by the next commit to that repo.
const indexLater = (workspaceId: string, repo: string) =>
  void syncFiles(workspaceId, repo).catch((error) => console.error(`indexing ${repo} failed`, error));

// Commit one file (created or replaced) or its removal (content null) as `author`. False when there's nothing
// to remove. Boxes pick the commit up on their next catch-up.
// Waits its turn with a box's push to the same repo (locked): Gitea refuses a write made while main moves under it.
export const writeFile = (workspaceId: string, repo: string, path: string, content: string | null, message: string, author: Author) =>
  locked(`${workspaceId}/${repo}`, () => writeFileNow(workspaceId, repo, path, content, message, author));

async function writeFileNow(workspaceId: string, repo: string, path: string, content: string | null, message: string, author: Author) {
  const sha = await shaOf(workspaceId, repo, path);
  if (content === null && !sha) return false;
  const res = await gitea(`/repos/${orgFor(workspaceId)}/${repo}/contents/${path}`, {
    method: content === null ? "DELETE" : sha ? "PUT" : "POST",
    body: JSON.stringify({
      ...(content !== null && { content: Buffer.from(content).toString("base64") }),
      ...(sha && { sha }),
      message,
      branch: "main",
      author,
      committer: author,
    }),
  });
  if (!res.ok) throw new Error(`gitea: write ${path} failed (${res.status})`);
  indexLater(workspaceId, repo);
  return true;
}

// Commit many files (each created or replaced) at once, as one commit (imports.ts).
// Several files in one commit; a null content deletes that file.
export const writeFiles = (workspaceId: string, repo: string, files: { path: string; content: string | Uint8Array | null }[], message: string, author: Author) =>
  locked(`${workspaceId}/${repo}`, () => writeFilesNow(workspaceId, repo, files, message, author));

async function writeFilesNow(workspaceId: string, repo: string, files: { path: string; content: string | Uint8Array | null }[], message: string, author: Author) {
  const shas = new Map((await listPaths(workspaceId, repo)).map((p) => [p.path, p.sha]));
  const res = await gitea(`/repos/${orgFor(workspaceId)}/${repo}/contents`, {
    method: "POST",
    body: JSON.stringify({
      branch: "main",
      message,
      author,
      committer: author,
      files: files.map((f) => ({
        operation: f.content === null ? "delete" : shas.has(f.path) ? "update" : "create",
        path: f.path,
        ...(f.content !== null && { content: Buffer.from(f.content).toString("base64") }),
        ...(shas.has(f.path) && { sha: shas.get(f.path) }),
      })),
    }),
  });
  if (!res.ok) throw new Error(`gitea: write ${files.length} files failed (${res.status})`);
  indexLater(workspaceId, repo);
}

// Emplio's own upkeep commits (moving files, repointing paths) are made under this name.
export const UPKEEP = { name: "Emplio", email: "noreply@emplio.app" };

// The person who last changed a file, passing over Emplio's own upkeep commits.
export async function lastAuthor(workspaceId: string, repo: string, path: string): Promise<Author | null> {
  const res = await gitea(`/repos/${orgFor(workspaceId)}/${repo}/commits?${new URLSearchParams({ sha: "main", path, limit: "10", stat: "false", files: "false" })}`);
  if (!res.ok) return null;
  const all = (await res.json()) as { commit: { author: Author } }[];
  return all.find((c) => c.commit.author.email !== UPKEEP.email)?.commit.author ?? null;
}

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-c", `http.extraHeader=${AUTH_HEADER}`, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

async function mustGit(cwd: string, ...args: string[]) {
  const r = await git(cwd, ...args);
  if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.err}`);
  return r.out;
}

// one git operation at a time per mirror
const locks = new Map<string, Promise<unknown>>();
function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

// Bare mirror of a repo, fetched fresh from Gitea. Returns its path and main's commit.
async function mirror(workspaceId: string, repo: string) {
  const dir = join(MIRRORS, orgFor(workspaceId), `${repo}.git`);
  const url = `${GITEA}/${orgFor(workspaceId)}/${repo}.git`;
  if (!(await Bun.file(join(dir, "HEAD")).exists())) {
    // macOS's temp cleanup can delete a mirror's files but leave its folders, which blocks a fresh clone
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await mustGit(dir, "clone", "-q", "--bare", url, ".");
  } else {
    await mustGit(dir, "fetch", "-q", url, "+refs/heads/main:refs/heads/main");
  }
  return { dir, url, head: await mustGit(dir, "rev-parse", "refs/heads/main") };
}

// What a box is missing: main's history after `base` (all of it when base is null), or null if up to date.
export const bundleFor = (workspaceId: string, repo: string, base: string | null) =>
  locked(`${workspaceId}/${repo}`, async () => {
    const m = await mirror(workspaceId, repo);
    if (base === m.head) return null;
    const file = join(m.dir, `out-${crypto.randomUUID()}.bundle`);
    try {
      await mustGit(m.dir, "bundle", "create", "-q", file, base ? `${base}..main` : "main");
      return new Uint8Array(await Bun.file(file).arrayBuffer());
    } finally {
      await rm(file, { force: true });
    }
  });

// The name a box's own git uses for anything not saved through the server, when the person has no GitHub account
// connected (their GitHub address otherwise). Nobody can sign in as it, so an automation it wrote has nobody to run as.
export const BOX_EMAIL = "bot@emplio.local";

// Why these commits can't go in, or null. A box is the agent's own computer, so nothing it says about itself counts:
// automations run as whoever a commit names, and a box's own limits on what staff change can be undone from inside it.
export async function refused(dir: string, base: string, who: Pusher) {
  const authors = await mustGit(dir, "log", "--format=%ae", `${base}..refs/incoming`);
  const theirs = [who.email.toLowerCase(), who.github?.toLowerCase(), BOX_EMAIL];
  const other = authors.split("\n").find((a) => a && !theirs.includes(a.toLowerCase()));
  if (other) return `a commit is signed ${other}`;
  if (!who.only) return null;
  const files = await mustGit(dir, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", base, "refs/incoming");
  const outside = files.split("\n").find((f) => f && !who.only!.test(f));
  return outside ? `${outside} isn't theirs to change` : null;
}

// Push the commits a box bundled, as `who`. False when Gitea moved on meanwhile (the box rebases and retries) or the
// commits were refused.
// ponytail: refused commits stay in that box and block its later saves to this repo; only a tampered box gets there
export const pushBundle = (workspaceId: string, repo: string, bundle: Uint8Array, who: Pusher) =>
  locked(`${workspaceId}/${repo}`, async () => {
    const m = await mirror(workspaceId, repo);
    const file = join(m.dir, `in-${crypto.randomUUID()}.bundle`);
    try {
      await Bun.write(file, bundle);
      await mustGit(m.dir, "fetch", "-q", file, "+main:refs/incoming");
      // behind main: nothing to judge yet, it comes back after catching up
      if (!(await git(m.dir, "merge-base", "--is-ancestor", m.head, "refs/incoming")).ok) return false;
      const no = await refused(m.dir, m.head, who);
      if (no) {
        console.warn(`refused a save to ${workspaceId}/${repo}: ${no}`);
        return false;
      }
      const pushed = await git(m.dir, "push", "-q", m.url, "refs/incoming:refs/heads/main");
      if (pushed.ok) indexLater(workspaceId, repo);
      return pushed.ok;
    } finally {
      await rm(file, { force: true });
    }
  });

// Emplio's computer is a Linux one with its files in /work. On a Mac that folder is a real one in the person's home
// (~/Emplio/<business>/work), so commands and files are translated at the door: /work in what comes in becomes that
// folder, and that folder in what goes out becomes /work again. Everything else about the command is left alone.
import { isAbsolute, join, relative, resolve } from "node:path";

// "/work" as a word of its own: not part of another path (a/work, ~/work, ./work, /workspace)
const WORD = /(?<![\w.~/-])\/work(?=$|[\s/"'\;:)|&<>,}\]])/g;

export const toLocal = (text, work) => String(text).replace(WORD, () => work);
export const toRemote = (text, work) => String(text).split(work).join("/work");

// A path the server gave (under /work) as a real one. Anything else, or any way out of the folder, is refused.
export function localPath(work, remote) {
  // a path the command printed came back as the real folder's (inside an emplio request, say): /work again first
  remote = toRemote(remote, work);
  if (remote !== "/work" && !String(remote).startsWith("/work/")) throw new Error(`only paths under /work: ${remote}`);
  const full = resolve(join(work, remote.slice("/work".length)));
  const rel = relative(work, full);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`outside /work: ${remote}`);
  return full;
}

// C:\\Users\\a\\Emplio as Git Bash on Windows writes it: /c/Users/a/Emplio
export const shellPath = (p) => String(p).replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, "/");

export const slug = (name) =>
  String(name || "business")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "business";

// ~/Emplio/<business name>-<first 8 of its id>
export const folderName = (workspaceId, name) => `${slug(name)}-${String(workspaceId).replace(/[^a-z0-9]/gi, "").slice(0, 8)}`;

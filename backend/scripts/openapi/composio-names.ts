// When an app moves off Composio, its actions keep Composio's names wherever one means the same call, so skills and
// saved automations carry over. Composio's own list is read from its docs when the actions are generated.
import type { AppConfig } from "../openapi-actions";

export async function composioNames(slug: string) {
  const res = await fetch(`https://docs.composio.dev/toolkits/${slug}`);
  if (!res.ok) throw new Error(`no Composio toolkit page for ${slug} (${res.status})`);
  const page = (await res.text()).replace(/\\"/g, '"');
  const from = page.indexOf('"tools":[');
  const part = page.slice(from);
  const prefix = `${slug.toUpperCase()}_`;
  return [...new Set([...part.slice(0, part.search(/\}\],"/)).matchAll(/\{"slug":"([A-Z0-9_]+)"/g)].map((m) => m[1]!.replace(prefix, "").toLowerCase()))];
}

const VERB: Record<string, string> = { retrieve: "get", fetch: "get", read: "get", show: "get", find: "get", modify: "update", edit: "update", remove: "delete", add: "create", post: "create" };
const SMALL = new Set(["a", "an", "the", "all", "your", "for", "of", "to", "in", "on", "by", "with", "from", "and", "new", "existing", "specific"]);
const key = (name: string) =>
  name.split("_").filter((w) => w && !SMALL.has(w)).map((w) => VERB[w] ?? w).sort().join("_");
const words = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/\b(a|an|the|all|your)\b/g, " ").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// Names an action after the operation's summary ("Create a customer" → create_customer), or Composio's name for the same call
// (by operation id, or a summary with the same words give or take articles and retrieve/get; plurals count, since "Get tasks" is a list and "Get task" isn't; never by the id's words, where a list and a get look alike). A name already taken keeps the operation id.
export function namer(theirs: string[]): NonNullable<AppConfig["name"]> {
  const exact = new Set(theirs);
  const close = new Map(theirs.map((n) => [key(n), n]));
  const taken = new Set<string>();
  return (id, _method, _path, op) => {
    const summary = words(String(op.summary ?? id));
    const name = exact.has(id) ? id : exact.has(summary) ? summary : (close.get(key(summary)) ?? summary);
    if (!taken.has(name)) return taken.add(name), name;
    return id;
  };
}

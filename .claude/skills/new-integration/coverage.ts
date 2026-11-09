// How an own app compares with Composio's toolkit of the same name: what Composio has that we don't.
// Run from backend/:  bun ../.claude/skills/new-integration/coverage.ts <app> [composio-slug]
// Names differ between the two, so a "missing" action is a name to check, not proof of a gap.
process.env.ENCRYPTION_KEY ??= "coverage";
process.env.DATABASE_URL ??= "postgres://x:y@127.0.0.1:1/z";

const app = process.argv[2];
if (!app) throw new Error("usage: bun coverage.ts <app> [composio-slug]");
const slug = process.argv[3] ?? app;

const res = await fetch(`https://docs.composio.dev/toolkits/${slug}`);
if (!res.ok) {
  console.log(`Composio has no toolkit page for ${slug} (${res.status}): judge coverage from the provider's docs alone.`);
  process.exit(0);
}
const page = (await res.text()).replace(/\\\\n/g, " ").replace(/\\"/g, '"');
const listed = (key: string) => {
  const from = page.indexOf(`"${key}":[`);
  if (from < 0) return [];
  const part = page.slice(from);
  const end = part.search(/\}\],"/);
  const prefix = `${slug.toUpperCase()}_`;
  const found = [...part.slice(0, end < 0 ? undefined : end).matchAll(/\{"slug":"([A-Z0-9_]+)"/g)].map((m) => m[1]!);
  return [...new Set(found)].map((s) => (s.startsWith(prefix) ? s.slice(prefix.length) : s).toLowerCase());
};

const { own } = await import("../../../backend/src/integrations/own/index");
const { listPolls } = await import("../../../backend/src/integrations/polls/index");
const short = (a: { action: string }) => a.action.split(".")[1]!;
const actions = (await own.listActions(app)).map(short);
const triggers = [...listPolls(app), ...((await own.listTriggers!(app)) ?? [])].map(short);

const SMALL = new Set(["a", "an", "the", "for", "of", "to", "in", "on", "by", "with", "from"]);
const words = (n: string) => n.split("_").filter((w) => !SMALL.has(w)).map((w) => w.replace(/s$/, "")).sort().join("_");

const compare = (kind: string, theirs: string[], ours: string[]) => {
  const same = new Set(ours);
  const close = new Set(ours.map(words));
  const missing = theirs.filter((n) => !same.has(n) && !close.has(words(n)));
  console.log(`\n${kind}: ours ${ours.length}, Composio ${theirs.length}, not matched by name ${missing.length}`);
  for (const n of missing) console.log(`  ${n}`);
};
compare("Triggers", listed("triggers"), triggers);
compare("Actions", listed("tools"), actions);
process.exit(0);

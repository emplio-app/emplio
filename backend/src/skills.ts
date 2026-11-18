// Skills: company/skillset/<name>/SKILL.md (the business's) and me/skillset/<name>/SKILL.md (one person's own).
// Git holds them; the `skills` table mirrors each one's name and description, synced from git's file list
// (only changed SKILL.md files are read again). The prompt lists them, and the chat box offers them as
// /name: a message starting with /name gets that SKILL.md handed to the agent with it. The box offers the
// apps we offer as /name too (/github): the agent is told to do it with that app.
import { FUZZY, matchScore, NO_MATCH, type Skill, type SlashCommand } from "@emplio/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { context } from "./auth";
import { db } from "./db";
import { automations, connections, skills } from "./db/schema";
import { listPaths, readFile } from "./gitea";
import { availableApps } from "./integrations";

type Who = { workspaceId: string; userId: string };
const SKILL_MD = /^skillset\/([^/]+)\/SKILL\.md$/;
const reposOf = (who: Who) => ["company", `me-${who.userId}`];

// A SKILL.md's description line, or its first line of text when it has none.
function describe(md: string) {
  const front = /^---\n([\s\S]*?)\n---/.exec(md);
  const line = front && /^description:\s*(.+)$/m.exec(front[1]!)?.[1];
  const text = line?.replace(/^["']|["']$/g, "") ?? md.slice(front?.[0].length ?? 0).split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "(no description)";
  return text.trim().slice(0, 150);
}

// Make the rows match git for the company and this person's own repo, and return them (theirs first).
// ponytail: one tree listing per repo per call; fine while it's once per message
const syncing = new Map<string, Promise<unknown>>();
export function syncSkills(who: Who): Promise<Skill[]> {
  const key = `${who.workspaceId}/${who.userId}`;
  const run = (syncing.get(key) ?? Promise.resolve()).then(async () => {
    const repos = reposOf(who);
    const rows = await db.select().from(skills).where(and(eq(skills.workspaceId, who.workspaceId), inArray(skills.repo, repos)));
    for (const repo of repos) {
      const files = (await listPaths(who.workspaceId, repo)).flatMap((f) => {
        const name = SKILL_MD.exec(f.path)?.[1];
        return name ? [{ name, sha: f.sha, path: f.path }] : [];
      });
      for (const row of rows.filter((r) => r.repo === repo && !files.some((f) => f.name === r.name)))
        await db.delete(skills).where(and(eq(skills.workspaceId, who.workspaceId), eq(skills.repo, repo), eq(skills.name, row.name)));
      for (const f of files) {
        if (rows.some((r) => r.repo === repo && r.name === f.name && r.sha === f.sha)) continue;
        const values = { workspaceId: who.workspaceId, repo, name: f.name, sha: f.sha, updatedAt: new Date(), description: describe((await readFile(who.workspaceId, repo, f.path)) ?? "") };
        await db.insert(skills).values(values).onConflictDoUpdate({ target: [skills.workspaceId, skills.repo, skills.name], set: values });
      }
    }
    const synced = await db.select().from(skills).where(and(eq(skills.workspaceId, who.workspaceId), inArray(skills.repo, repos)));
    return synced
      .map((r) => ({ name: r.name, description: r.description, scope: r.repo === "company" ? ("company" as const) : ("me" as const) }))
      .sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "me" ? -1 : 1));
  });
  syncing.set(key, run.catch(() => {}));
  return run;
}

// What a message starting with /name asks for, as the agent should get it; null when it's neither a skill nor
// an app. A skill wins over an app of the same name, and their own skill over the company's.
export async function slashCommand(who: Who, text: string) {
  const name = /^\/([\w.-]+)(?=\s|$)/.exec(text)?.[1];
  if (!name) return null;
  const found = (await syncSkills(who)).find((s) => s.name === name);
  if (!found) {
    const app = (await availableApps()).find((a) => a.app === name.toLowerCase());
    return app
      ? `The person started with /${app.app}: they want this done with ${app.name}, using their own ${app.name} account (emplio apps list shows it; if it isn't connected, emplio apps add ${app.app}).`
      : null;
  }
  const folder = `${found.scope}/skillset/${name}`;
  const md = await readFile(who.workspaceId, found.scope === "me" ? `me-${who.userId}` : "company", `skillset/${name}/SKILL.md`);
  return md === null ? null : `The person picked the skill /${name}: follow ${folder}/SKILL.md for this message (its scripts and files are in ${folder}/).\n\n${md}`;
}

// The / menu's search: skills, automations and apps whose name (or description) has what's typed, best
// first, a few of each, from the mirrored rows; opening the menu (nothing typed) also syncs skills from git behind.
const PER_KIND = 5;
export async function searchCommands(who: Who, query: string): Promise<SlashCommand[]> {
  const q = query.trim().toLowerCase().slice(0, 60);
  const [skillList, autos, apps, connected] = await Promise.all([
    db
      .select()
      .from(skills)
      .where(and(eq(skills.workspaceId, who.workspaceId), inArray(skills.repo, reposOf(who))))
      .then((rows) => rows.map((r) => ({ name: r.name, description: r.description, scope: r.repo === "company" ? ("company" as const) : ("me" as const) })))
      // nothing mirrored yet: wait for git once; otherwise answer from the rows and catch up with git behind
      .then((rows) => (rows.length ? (!q && syncSkills(who).catch(() => {}), rows) : syncSkills(who).catch(() => []))),
    db
      .select({ name: automations.name, prompt: automations.prompt })
      .from(automations)
      .where(and(eq(automations.workspaceId, who.workspaceId), isNull(automations.error))),
    availableApps().catch(() => []),
    db
      .selectDistinct({ app: connections.app })
      .from(connections)
      .where(and(eq(connections.workspaceId, who.workspaceId), eq(connections.userId, who.userId), eq(connections.status, "active")))
      .then((rows) => new Set(rows.map((r) => r.app))),
  ]);
  const best = <T extends { name: string }>(items: T[], more: (t: T) => string, first?: (t: T) => boolean) =>
    items
      .map((t) => ({ t, s: matchScore(t.name, more(t), q) }))
      .filter((x) => x.s < NO_MATCH)
      .map((x) => ({ ...x, s: x.s - (first?.(x.t) ? 10 : 0) }))
      .sort((a, b) => a.s - b.s || a.t.name.localeCompare(b.t.name))
      .slice(0, PER_KIND)
      .map((x) => x.t);
  // letters in order or a typo only count when nothing matches properly, so they never crowd out what was meant
  const found = [
    ...best(skillList, (s) => s.description, (s) => s.scope === "me").map((s): SlashCommand => ({ kind: "skill", ...s })),
    ...best(autos, (a) => a.prompt).map((a): SlashCommand => ({ kind: "automation", name: a.name, description: `Run now · ${a.prompt.split("\n").find((l) => l.trim()) ?? ""}` })),
    // with nothing typed, only the apps they've connected; a search reaches every app we offer, theirs first
    ...best(q ? apps : apps.filter((a) => connected.has(a.app)), (a) => `${a.name} ${a.description}`, (a) => connected.has(a.app)).map(
      (a): SlashCommand => ({ kind: "app", name: a.app, description: connected.has(a.app) ? `Use ${a.name}` : `Use ${a.name} (not connected yet)`, logo: a.logo, connected: connected.has(a.app) }),
    ),
  ];
  return found.some((c) => matchScore(c.name, c.description, q) < FUZZY) ? found.filter((c) => matchScore(c.name, c.description, q) < FUZZY) : found;
}

export async function skillRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>("/commands", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return searchCommands(ctx, req.query.q ?? "");
  });

  // for the chat box's / menu
  app.get("/skills", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return syncSkills(ctx);
  });
}

// Meetings: when, about which client or project, and who was in it — rows, so who may read a private one's notes
// comes from here (records.ts visibleMeeting), never from what the note says. The notes are the file
// meetings/<slug>.md, in company/ or, while the meeting is private (its own switch, or its client's or project's),
// in restricted/; placeMeetings moves a file whenever that changes. Anyone adds one; changing or removing it is for
// owners, admins, whoever added it and the teammates in it.
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Meeting } from "@emplio/shared";
import { db } from "./db";
import { clients, contacts, meetings, projects, users } from "./db/schema";
import { listPaths, readFile } from "./gitea";
import { moveNotes } from "./private";
import { clean, dateOnly, freeSlug, isAdmin, logChange, meetingOf, meetingPrivate, parseArgs, personIn, privateOf, seesPrivate, visibleMeeting, wsOf, type Viewer, type Who } from "./records";

type Input = { title?: string; on?: string; client?: string | null; project?: string | null; people?: string; private?: boolean };
type Result = { ok: true; meeting: Meeting } | { ok: false; error: string };

const fileOf = (slug: string) => `meetings/${slug}.md`;
// where Emplio writes its notes: a team member's copy of a private one is in shared/ (sandbox.ts syncShared)
export const meetingNotesAt = (v: Viewer, m: Meeting) => (m.hidden && !seesPrivate(v) ? `/work/shared/${fileOf(m.slug)}` : `/work/${m.path}`);

export async function listMeetings(v: Viewer, f: { clientId?: string; projectId?: string; ids?: string[]; userId?: string } = {}): Promise<Meeting[]> {
  const workspaceId = wsOf(v);
  await syncMeetings(workspaceId);
  const where: (SQL | undefined)[] = [eq(meetings.workspaceId, workspaceId), visibleMeeting(v)];
  if (f.clientId) where.push(eq(meetings.clientId, f.clientId));
  if (f.projectId) where.push(eq(meetings.projectId, f.projectId));
  if (f.ids) where.push(f.ids.length ? inArray(meetings.id, f.ids) : sql`false`);
  if (f.userId) where.push(sql`${f.userId} = any(${meetings.teamIds})`);
  const rows = await db
    .select({ m: meetings, hidden: meetingPrivate, client: { id: clients.id, slug: clients.slug, name: clients.name }, project: { id: projects.id, slug: projects.slug, name: projects.name } })
    .from(meetings)
    .leftJoin(clients, eq(clients.id, meetings.clientId))
    .leftJoin(projects, eq(projects.id, meetings.projectId))
    .where(and(...where))
    .orderBy(desc(meetings.on), desc(meetings.createdAt));
  const teamIds = [...new Set(rows.flatMap((r) => r.m.teamIds))];
  const contactIds = [...new Set(rows.flatMap((r) => r.m.contactIds))];
  const [people, cs] = await Promise.all([
    teamIds.length ? db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, teamIds)) : [],
    contactIds.length ? db.select({ id: contacts.id, slug: contacts.slug, name: contacts.name }).from(contacts).where(inArray(contacts.id, contactIds)) : [],
  ]);
  return rows.map(({ m, hidden, client, project }) => ({
    id: m.id,
    slug: m.slug,
    title: m.title,
    on: m.on,
    client: client?.id ? client : null,
    project: project?.id ? project : null,
    team: m.teamIds.flatMap((id) => people.filter((p) => p.id === id).map((p) => ({ id, name: p.name ?? p.email }))),
    contacts: m.contactIds.flatMap((id) => cs.filter((c) => c.id === id)),
    others: m.others,
    private: m.private,
    hidden: !!hidden,
    path: `${hidden ? "restricted" : "company"}/${fileOf(m.slug)}`,
    updatedAt: m.updatedAt.toISOString(),
  }));
}

export async function findMeeting(v: Viewer, q: string): Promise<Meeting | string> {
  const s = clean(q).toLowerCase();
  if (!s) return "which meeting?";
  const all = await listMeetings(v);
  const hit = all.find((m) => m.slug === s) ?? all.find((m) => m.title.toLowerCase() === s);
  if (hit) return hit;
  const loose = all.filter((m) => m.slug.includes(s) || m.title.toLowerCase().includes(s));
  if (loose.length === 1) return loose[0]!;
  return loose.length ? `"${q}" matches ${loose.slice(0, 8).map((m) => `${m.title} on ${m.on} (${m.slug})`).join(", ")}; say which` : `no meeting "${q}" (emplio meetings list)`;
}

// "Sarah, Jane Doe, the auditor": a teammate, else a contact, else just a name. A string is what's wrong
async function peopleOf(w: Who, given: string) {
  const { listTeam } = await import("./team");
  const { findContact } = await import("./contacts");
  const team = await listTeam(w.workspaceId);
  const out = { teamIds: [] as string[], contactIds: [] as string[], others: [] as string[] };
  for (const name of given.split(",").map(clean).filter(Boolean)) {
    const m = personIn(team, name, w.userId);
    if (typeof m !== "string") out.teamIds.push(m.id);
    else if (!m.startsWith("nobody")) return m;
    else {
      const c = await findContact(w, name, true);
      if (typeof c !== "string") out.contactIds.push(c.id);
      else out.others.push(name.slice(0, 100));
    }
  }
  return { teamIds: [...new Set(out.teamIds)], contactIds: [...new Set(out.contactIds)], others: out.others };
}

async function values(w: Who, i: Input) {
  const v: Partial<typeof meetings.$inferInsert> = {};
  if (i.title !== undefined) {
    v.title = clean(i.title).slice(0, 200);
    if (!v.title) return "a meeting needs a title";
  }
  if (i.on !== undefined) {
    const d = dateOnly(i.on);
    if (d === null || typeof d === "object") return d?.error ?? "when was it? --date YYYY-MM-DD";
    v.on = d;
  }
  const none = (s: string | null | undefined) => s === null || !clean(s) || clean(s).toLowerCase() === "none";
  if (i.project !== undefined) {
    if (none(i.project)) v.projectId = null;
    else {
      const { findProject } = await import("./projects");
      const p = await findProject(w, i.project!);
      if (typeof p === "string") return p;
      v.projectId = p.id;
      // a project's meeting is its client's too
      if (i.client === undefined) v.clientId = p.client.id;
    }
  }
  if (i.client !== undefined) {
    if (none(i.client)) v.clientId = null;
    else {
      const { findClient } = await import("./clients");
      const c = await findClient(w, i.client!);
      if (typeof c === "string") return c;
      v.clientId = c.id;
    }
  }
  if (i.people !== undefined) {
    const p = await peopleOf(w, i.people);
    if (typeof p === "string") return p;
    Object.assign(v, p);
  }
  if (i.private !== undefined) {
    if (!isAdmin(w)) return "only the owner or an admin can make a meeting private";
    v.private = i.private;
  }
  return v;
}

// owners, admins, whoever added it and the teammates in it
const mayChange = async (w: Who, id: string) =>
  isAdmin(w) || !!(await db.select({ id: meetings.id }).from(meetings).where(and(eq(meetings.id, id), sql`(${w.userId} = any(${meetings.teamIds}) or ${meetings.createdById} = ${w.userId})`))).length;

export async function addMeeting(w: Who, input: Input & { title: string }): Promise<Result> {
  const v = await values(w, { on: new Date().toISOString().slice(0, 10), ...input });
  if (typeof v === "string") return { ok: false, error: v };
  const taken = await db.select({ slug: meetings.slug }).from(meetings).where(eq(meetings.workspaceId, w.workspaceId));
  const slug = freeSlug(`${v.on} ${v.title}`, taken.map((t) => t.slug), "meeting");
  const [row] = await db.transaction(async (tx) => {
    const r = await tx.insert(meetings).values({ ...v, workspaceId: w.workspaceId, slug, title: v.title!, on: v.on!, createdById: w.userId || null }).returning();
    await logChange(tx, w, { kind: "meeting", id: r[0]!.id, clientId: r[0]!.clientId, summary: `Added meeting ${v.title} (${v.on})`, changes: [] });
    return r;
  });
  return { ok: true, meeting: (await listMeetings(w.workspaceId, { ids: [row!.id] }))[0]! };
}

export async function updateMeeting(w: Who, q: string, input: Input): Promise<Result> {
  const m = await findMeeting(w, q);
  if (typeof m === "string") return { ok: false, error: m };
  if (!(await mayChange(w, m.id))) return { ok: false, error: "only the owner, an admin, whoever added it or the teammates in it change a meeting" };
  const v = await values(w, input);
  if (typeof v === "string") return { ok: false, error: v };
  if (!Object.keys(v).length) return { ok: true, meeting: m };
  await db.transaction(async (tx) => {
    await tx.update(meetings).set({ ...v, updatedAt: new Date() }).where(eq(meetings.id, m.id));
    await logChange(tx, w, { kind: "meeting", id: m.id, clientId: v.clientId === undefined ? (m.client?.id ?? null) : v.clientId, summary: `Changed ${Object.keys(v).join(", ")} of meeting ${m.title}`, changes: [] });
  });
  // a new client, project or switch may make it private, or everyone's again
  const moved = await placeMeetings(w.workspaceId).then(() => null, (e) => `saved, but its notes couldn't be moved (${e instanceof Error ? e.message : e})`);
  if (moved) return { ok: false, error: moved };
  return { ok: true, meeting: (await listMeetings(w.workspaceId, { ids: [m.id] }))[0]! };
}

// Added by mistake: the row and its notes go. ponytail: deleted, not archived; a meeting that happened stays
export async function removeMeeting(w: Who, q: string): Promise<Result> {
  const m = await findMeeting(w, q);
  if (typeof m === "string") return { ok: false, error: m };
  if (!(await mayChange(w, m.id))) return { ok: false, error: "only the owner, an admin, whoever added it or the teammates in it remove a meeting" };
  const { writeFiles, UPKEEP } = await import("./gitea");
  const repo = m.path.split("/")[0]!;
  if ((await listPaths(w.workspaceId, repo)).some((p) => p.path === fileOf(m.slug))) await writeFiles(w.workspaceId, repo, [{ path: fileOf(m.slug), content: null }], `Removed meeting ${m.title}`, UPKEEP);
  await db.transaction(async (tx) => {
    await tx.delete(meetings).where(eq(meetings.id, m.id));
    await logChange(tx, w, { kind: "meeting", id: m.id, clientId: m.client?.id ?? null, summary: `Removed meeting ${m.title} (${m.on})`, changes: [] });
  });
  return { ok: true, meeting: m };
}

// Each meeting's notes in the folder its privacy says: into restricted/ while private, back to company/ after.
// Run after anything that can change that (a client's, project's or meeting's switch, a meeting's links).
// ponytail: lists both repos each time; fine for hundreds of meetings
export async function placeMeetings(workspaceId: string) {
  const rows = await db.select({ slug: meetings.slug, hidden: meetingPrivate }).from(meetings).where(eq(meetings.workspaceId, workspaceId));
  if (!rows.length) return;
  const [company, restricted] = await Promise.all(["company", "restricted"].map((r) => listPaths(workspaceId, r).then((ps) => new Set(ps.map((p) => p.path)), () => new Set<string>())));
  const toPrivate = rows.filter((r) => r.hidden && company!.has(fileOf(r.slug))).map((r) => fileOf(r.slug));
  const toShared = rows.filter((r) => !r.hidden && restricted!.has(fileOf(r.slug))).map((r) => fileOf(r.slug));
  if (toPrivate.length) await moveNotes(workspaceId, toPrivate, true, "Meeting notes made private");
  if (toShared.length) await moveNotes(workspaceId, toShared, false, "Meeting notes shared with everyone");
}

// A meeting note written without its row (older ones, from before meetings were rows) gets one, read from the note:
// its date from the name, its title from the first heading, its client and project from its first [[links]], and
// who was in it from a `people:` line. Then every note goes where its meeting's privacy says.
// ponytail: names only of lowercase letters, digits and dashes; another stays a plain note
const SLUG = /^meetings\/([a-z0-9][a-z0-9-]*)\.md$/;
const syncing = new Map<string, Promise<void>>();
export function syncMeetings(workspaceId: string): Promise<void> {
  const running = syncing.get(workspaceId);
  if (running) return running;
  const run = (async () => {
    const found = (
      await Promise.all(
        ["company", "restricted"].map(async (repo) => (await listPaths(workspaceId, repo).catch(() => [])).flatMap((p) => (SLUG.exec(p.path) ? [{ repo, slug: SLUG.exec(p.path)![1]! }] : []))),
      )
    ).flat();
    const have = new Set((await db.select({ slug: meetings.slug }).from(meetings).where(eq(meetings.workspaceId, workspaceId))).map((r) => r.slug));
    const fresh = found.filter((f) => !have.has(f.slug));
    if (fresh.length) {
      const { listTeam } = await import("./team");
      const team = await listTeam(workspaceId);
      for (const f of fresh) {
        if (have.has(f.slug)) continue;
        have.add(f.slug);
        const text = (await readFile(workspaceId, f.repo, fileOf(f.slug))) ?? "";
        const link = (kind: string) => new RegExp(`\\[\\[${kind}/([a-z0-9-]+)`).exec(text)?.[1];
        const [client] = link("clients") ? await db.select({ id: clients.id, private: clients.private }).from(clients).where(and(eq(clients.workspaceId, workspaceId), eq(clients.slug, link("clients")!))) : [];
        const [project] = link("projects")
          ? await db.select({ id: projects.id, clientId: projects.clientId, private: projects.private }).from(projects).where(and(eq(projects.workspaceId, workspaceId), eq(projects.slug, link("projects")!)))
          : [];
        const names = (/^people:(.*)$/im.exec(text)?.[1] ?? "").split(",").map(clean).filter(Boolean);
        const teamIds = names.flatMap((n) => team.filter((t) => t.name?.toLowerCase() === n.toLowerCase() || t.email === n.toLowerCase()).map((t) => t.id));
        const on = /^\d{4}-\d{2}-\d{2}/.exec(f.slug)?.[0];
        const row = {
          workspaceId,
          slug: f.slug,
          title: clean(/^#\s+(.+)$/m.exec(text)?.[1] ?? f.slug.replace(/^\d{4}-\d{2}-\d{2}-?/, "").replace(/-/g, " ")).slice(0, 200) || "Meeting",
          on: on && !Number.isNaN(Date.parse(on)) ? on : new Date().toISOString().slice(0, 10),
          clientId: client?.id ?? project?.clientId ?? null,
          projectId: project?.id ?? null,
          teamIds: [...new Set(teamIds)],
          others: names.filter((n) => !team.some((t) => t.name?.toLowerCase() === n.toLowerCase() || t.email === n.toLowerCase())).slice(0, 20),
          // in the owners' folder for no reason of its client's: private on its own
          private: f.repo === "restricted" && !client?.private && !project?.private,
        };
        await db.insert(meetings).values(row).onConflictDoNothing();
      }
    }
    await placeMeetings(workspaceId);
  })().finally(() => syncing.delete(workspaceId));
  syncing.set(workspaceId, run);
  return run;
}

// --- `emplio meetings` ---

export const USAGE = `usage: emplio meetings list [--client <client>] [--project <project>] [--with <teammate>]   newest first
       emplio meetings show <meeting>
       emplio meetings add <title> [options]          then write its notes at the path it gives
       emplio meetings update <meeting> [options]     only what you name changes
       emplio meetings remove <meeting>               one added by mistake: it and its notes go
options: --date YYYY-MM-DD      when it was (add: today)
         --client <client>      who it was with or about; "none" clears it
         --project <project>    the project it was for (its client too); "none" clears it
         --people "<a, b, c>"   who was in it: teammates, contacts, anyone else by name (update: the whole list)
         --title <new title>    update only
         --private yes|no       owners and admins only (and the teammates in it); a private client's or project's is already
Who may read a private meeting's notes comes from its client, project and people here, so name them all.`;

const line = (m: Meeting) =>
  [m.slug, m.on, m.title, m.client ? `client ${m.client.slug}` : "", m.project ? `project ${m.project.slug}` : "", [...m.team.map((p) => p.name), ...m.contacts.map((c) => c.name), ...m.others].join(", "), m.hidden ? "PRIVATE" : ""]
    .filter(Boolean)
    .join("\t");

export async function meetingsCommand(base: Omit<Who, "via" | "conversationId">, conversationId: string, args: string[], data = false): Promise<string> {
  const w: Who = { ...base, via: "emplio", conversationId };
  const [sub, ...rest] = args;
  const { words, opts, flags } = parseArgs(rest);
  const name = words.join(" ");
  const input = (): Input => {
    const i: Input = {};
    if (opts.title !== undefined) i.title = opts.title;
    if (opts.date !== undefined) i.on = opts.date;
    if (opts.client !== undefined) i.client = opts.client;
    if (opts.project !== undefined) i.project = opts.project;
    if (opts.people !== undefined) i.people = opts.people;
    const priv = privateOf(opts, flags);
    if (priv !== undefined) i.private = priv;
    return i;
  };
  const notes = (m: Meeting) => `notes: ${meetingNotesAt(w, m)}`;
  if (sub === "list") {
    const f: Parameters<typeof listMeetings>[1] = {};
    if (opts.client) {
      const { findClient } = await import("./clients");
      const c = await findClient(w, opts.client);
      if (typeof c === "string") return `error: ${c}`;
      f.clientId = c.id;
    }
    if (opts.project) {
      const { findProject } = await import("./projects");
      const p = await findProject(w, opts.project);
      if (typeof p === "string") return `error: ${p}`;
      f.projectId = p.id;
    }
    if (opts.with) {
      const { listTeam } = await import("./team");
      const m = personIn(await listTeam(w.workspaceId), opts.with, w.userId);
      if (typeof m === "string") return `error: ${m}`;
      f.userId = m.id;
    }
    const list = (await listMeetings(w, f)).slice(0, 100);
    if (data) return JSON.stringify(list);
    return list.length ? list.map(line).join("\n") : 'No meetings yet. Add one with emplio meetings add "<title>" --client <client> --people "<who was in it>".';
  }
  if (sub === "show" && name) {
    const m = await findMeeting(w, name);
    if (typeof m === "string") return `error: ${m}`;
    if (data) return JSON.stringify(m);
    return [
      `${m.title} (${m.slug}) · ${m.on}${m.hidden ? " · PRIVATE (owners, admins and the people it's shared with)" : ""}`,
      `client: ${m.client?.name ?? "none"}${m.project ? ` · project: ${m.project.name}` : ""}`,
      `people: ${[...m.team.map((p) => `${p.name} (team)`), ...m.contacts.map((c) => `${c.name} (contact)`), ...m.others].join(", ") || "nobody named yet"}`,
      notes(m),
    ].join("\n");
  }
  if (sub === "add" && name) {
    const r = await addMeeting(w, { ...input(), title: name });
    return r.ok ? `added ${line(r.meeting)}\n${notes(r.meeting)} (write them there: what was said, decided, and who does what next)` : `error: ${r.error}`;
  }
  if (sub === "update" && name) {
    if (!Object.keys(input()).length) return USAGE;
    const r = await updateMeeting(w, name, input());
    return r.ok ? `updated ${line(r.meeting)}\n${notes(r.meeting)}` : `error: ${r.error}`;
  }
  if ((sub === "remove" || sub === "delete") && name) {
    const r = await removeMeeting(w, name);
    return r.ok ? `removed ${r.meeting.title} and its notes` : `error: ${r.error}`;
  }
  return USAGE;
}

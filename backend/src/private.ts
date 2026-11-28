// Private records: a client, contact, project or service only owners and admins see. Everyone else's lists, pickers,
// mentions and `emplio` commands leave it out (records.ts seesPrivate), and its notes folder lives in restricted/
// (owners' and admins' git) instead of company/, so nobody else's computer ever has it (and a team member's computer
// keeps no past versions of company/: sandbox.ts FORGET).
// Each record has its own switch. A project is private too while its client is, and a contact while every client
// they're at is: worked out each time (the records' lists), never stored, so sharing a client again shares exactly
// what it hid. Notes follow: whenever what's private changes (a switch, a project moved, a contact's clients changed),
// the folders of the records that changed with it move.
// Meetings follow too (meetings.ts placeMeetings). ponytail: knowledge notes naming a private client stay in company/;
// Emplio is told to keep them out
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { clients, contactClients, contacts, meetings, projects, services } from "./db/schema";
import { ensureRepo, listPaths, readFile, UPKEEP, writeFiles } from "./gitea";
import { allClientsPrivate, contactPrivate, handles, isAdmin, logChange, meetingPrivate, projectPrivate, seesPrivate, visibleContact, visibleMeeting, visibleProject, type Kind, type Viewer, type Who } from "./records";

type Target = { kind: Kind; id: string; slug: string; name: string; clientId: string | null };
const TABLES = { client: clients, contact: contacts, project: projects, service: services } as unknown as Record<Kind, typeof clients>;
const REPOS = { company: "Shared company files", restricted: "Finance, HR and owner notes" } as const;

// company/clients/northwind/index.md, or restricted/... for a private one
export const notesDir = (kind: Kind, r: { slug: string; private?: boolean }) => `${r.private ? "restricted" : "company"}/${kind}s/${r.slug}`;

// The files under these folders (clients/northwind/), or these files (meetings/x.md), among a repo's paths
export const inFolders = (paths: string[], folders: string[]) => paths.filter((p) => folders.some((f) => p === f || p.startsWith(`${f}/`)));

// Their notes folders from one repo to the other: written there first, then removed here, so a failure halfway leaves
// a copy in both, never none. ponytail: a box writing the old folder at that moment puts a file back there; the next
// switch of that record moves it again
export async function moveNotes(workspaceId: string, folders: string[], toPrivate: boolean, why: string) {
  const [from, to] = toPrivate ? (["company", "restricted"] as const) : (["restricted", "company"] as const);
  const paths = inFolders((await listPaths(workspaceId, from)).map((p) => p.path), folders);
  if (!paths.length) return;
  await ensureRepo(workspaceId, to, REPOS[to]);
  const files = await Promise.all(paths.map(async (path) => ({ path, content: (await readFile(workspaceId, from, path)) ?? "" })));
  await writeFiles(workspaceId, to, files, why, UPKEEP);
  await writeFiles(workspaceId, from, paths.map((path) => ({ path, content: null })), why, UPKEEP);
}

// Whose privacy changes when this one's switch goes to `on`: itself (unless its client keeps it private either way)
// and, for a client, its projects and the contacts at no shared client, those not private on their own
export async function targets(workspaceId: string, kind: Kind, id: string, on: boolean): Promise<Target[]> {
  const t = TABLES[kind];
  const [self] = await db
    .select({
      id: t.id,
      slug: t.slug,
      name: t.name,
      own: t.private,
      kept:
        kind === "project"
          ? sql<boolean>`exists (select 1 from ${clients} c where c.id = ${projects.clientId} and c.private)`
          : kind === "contact"
            ? allClientsPrivate()
            : sql<boolean>`false`,
      clientId: kind === "project" ? projects.clientId : sql<string | null>`null`,
    })
    .from(t)
    .where(and(eq(t.workspaceId, workspaceId), eq(t.id, id)));
  if (!self || self.own === on) return [];
  const out: Target[] = self.kept ? [] : [{ kind, id: self.id, slug: self.slug, name: self.name, clientId: kind === "client" ? self.id : self.clientId }];
  if (kind === "client") {
    const ps = await db.select({ id: projects.id, slug: projects.slug, name: projects.name }).from(projects).where(and(eq(projects.clientId, id), eq(projects.private, false)));
    out.push(...ps.map((p) => ({ ...p, kind: "project" as const, clientId: id })));
    // the ones whose "every client private" turns with this one
    const cs = await db
      .select({ id: contacts.id, slug: contacts.slug, name: contacts.name })
      .from(contacts)
      .innerJoin(contactClients, eq(contactClients.contactId, contacts.id))
      .where(and(eq(contactClients.clientId, id), eq(contacts.private, false), allClientsPrivate({ id, on: true })));
    out.push(...cs.map((c) => ({ ...c, kind: "contact" as const, clientId: id })));
  }
  return out;
}

const moveFailed = (e: unknown) => (console.error("moving notes failed", e), e instanceof Error ? e.message : String(e));

// Make one private (on) or everyone's again. A string is what's wrong.
export async function setPrivate(w: Who, kind: Kind, id: string, on: boolean): Promise<string | null> {
  if (!isAdmin(w)) return "only the owner or an admin can make something private";
  const t = TABLES[kind];
  const [self] = await db.select({ name: t.name, own: t.private }).from(t).where(and(eq(t.workspaceId, w.workspaceId), eq(t.id, id)));
  if (!self || self.own === on) return null;
  const moving = await targets(w.workspaceId, kind, id, on);
  const why = `${on ? "Made private" : "Shared with everyone"}: ${self.name}`;
  const folders = moving.map((x) => `${x.kind}s/${x.slug}`);
  // the notes leave company/ before anyone's lists stop hiding it, and come back only after: a failure keeps it hidden
  if (on && folders.length) {
    const failed = await moveNotes(w.workspaceId, folders, true, why).then(() => null, moveFailed);
    if (failed) return `its notes couldn't be moved to the owners' folder, so nothing changed; try again (${failed})`;
  }
  const others = moving.filter((x) => x.id !== id).map((x) => x.name);
  await db.transaction(async (tx) => {
    await tx.update(t).set({ private: on, updatedAt: new Date() }).where(eq(t.id, id));
    await logChange(tx, w, {
      kind,
      id,
      clientId: kind === "client" ? id : (moving[0]?.clientId ?? null),
      summary: `${on ? "Made" : "Shared"} ${self.name}${on ? " private (owners and admins only)" : " with everyone"}${others.length ? `, and with it ${others.join(", ")}` : ""}`,
      changes: [{ field: "private", from: !on, to: on }],
    });
  });
  if (!on && folders.length) {
    const failed = await moveNotes(w.workspaceId, folders, false, why).then(() => null, moveFailed);
    // still in the owners' folder: the safe way to fail
    if (failed) return `shared, but its notes are still in the owners' folder; switch it to private and back to try again (${failed})`;
  }
  return placeAll(w.workspaceId);
}

// its meetings' notes follow (meetings.ts; imported late, as it uses moveNotes)
const placeAll = (workspaceId: string) =>
  import("./meetings").then((m) => m.placeMeetings(workspaceId)).then(
    () => null,
    (e) => `saved, but its meetings' notes couldn't be moved (${moveFailed(e)})`,
  );

// After a project moved to another client or a contact's clients changed: if that changed whether it's private, its
// notes move to match. A string is what's wrong.
export async function followNotes(workspaceId: string, kind: "project" | "contact", r: { slug: string; name: string }, was: boolean, now: boolean) {
  if (was === now) return null;
  if (kind === "project") {
    const failed = await placeAll(workspaceId);
    if (failed) return failed;
  }
  return moveNotes(workspaceId, [`${kind}s/${r.slug}`], now, `${now ? "Made private" : "Shared with everyone"}: ${r.name}`).then(
    () => null,
    (e) => `saved, but its notes couldn't be moved ${now ? "to the owners' folder" : "back to the shared folder"} (${moveFailed(e)})`,
  );
}

// What of the owners' files a team member gets (in shared/ on their computer, and in the app's Files): the notes
// folders of the private clients they handle, of the private projects and contacts that come with them and of the
// private projects they lead, and the notes of the private meetings that are theirs (records.ts meetingOf).
// The rule is the records' own (records.ts visibleProject, visibleContact, visibleMeeting), so a list and the files
// never disagree.
export async function sharedWith(workspaceId: string, userId: string) {
  const v = { workspaceId, role: "member" as const, userId };
  await import("./meetings").then((m) => m.syncMeetings(workspaceId)).catch((e) => console.error("syncing meetings failed", e));
  const [cs, ps, ks, ms] = await Promise.all([
    db.select({ slug: clients.slug }).from(clients).where(and(eq(clients.workspaceId, workspaceId), eq(clients.private, true), handles(userId, clients.id))),
    db.select({ slug: projects.slug }).from(projects).where(and(eq(projects.workspaceId, workspaceId), projectPrivate, visibleProject(v))),
    db.select({ slug: contacts.slug }).from(contacts).where(and(eq(contacts.workspaceId, workspaceId), contactPrivate, visibleContact(v))),
    db.select({ slug: meetings.slug }).from(meetings).where(and(eq(meetings.workspaceId, workspaceId), meetingPrivate, visibleMeeting(v))),
  ]);
  const folders = [...cs.map((c) => `clients/${c.slug}`), ...ps.map((p) => `projects/${p.slug}`), ...ks.map((k) => `contacts/${k.slug}`)];
  const files = new Set(ms.map((m) => `meetings/${m.slug}.md`));
  return { folders, test: (path: string) => files.has(path) || folders.some((f) => path.startsWith(`${f}/`)) };
}

// What a team member may change in company/ (sandbox.ts writableFor): inbox/, and these clients', projects' and
// meetings' notes. A regex for both the box's check (grep -E) and the server's: plain groups only; slugs need no escaping
export const writableRegex = (clientSlugs: string[], projectSlugs: string[], meetingSlugs: string[] = []) =>
  new RegExp(
    `^(inbox/${clientSlugs.map((c) => `|clients/${c}/`).join("")}${projectSlugs.map((p) => `|projects/${p}/`).join("")}${meetingSlugs.map((m) => `|meetings/${m}\\.md$`).join("")})`,
  );

// Where Emplio finds a record's notes: its files, or (a private one, for a team member who may see it: a handler)
// their copy of them in shared/ (sandbox.ts syncShared)
export const notesAt = (w: Viewer | undefined, kind: "client" | "contact" | "project", r: { slug: string; private?: boolean }) =>
  r.private && w && !seesPrivate(w) ? `/work/shared/${kind}s/${r.slug}/index.md` : `/work/${notesDir(kind, r)}/index.md`;

if (import.meta.main) {
  console.assert(notesDir("client", { slug: "acme", private: true }) === "restricted/clients/acme");
  console.assert(notesDir("contact", { slug: "ivy" }) === "company/contacts/ivy");
  const got = inFolders(["clients/acme/index.md", "clients/acme-2/index.md", "clients/acme/decisions.md", "meetings/x.md"], ["clients/acme"]);
  console.assert(got.join() === "clients/acme/index.md,clients/acme/decisions.md", got.join());
  console.log("ok");
}

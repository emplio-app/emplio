import { afterAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { addClient, findClient, listClients } from "./clients";
import { addContact, findContact, listContacts, updateContact } from "./contacts";
import { removeField, saveField } from "./fields";
import { db } from "./db";
import { clientHandlers, clients, contacts, meetings, tasks, users, workspaceMembers, workspaces } from "./db/schema";
import { addMeeting, listMeetings, updateMeeting } from "./meetings";
import { addProject, listProjects, updateProject } from "./projects";
import { notesAt, sharedWith, targets, writableRegex } from "./private";
import { historyOf, seesPrivate } from "./records";
import { listTasks, updateTask } from "./tasks";

// against the local database: a throwaway business with a client, a contact there, a project and a task for it
const tag = crypto.randomUUID().slice(0, 8);
const [ws] = await db.insert(workspaces).values({ name: `records-test-${tag}` }).returning();
const [user] = await db.insert(users).values({ email: `records-test-${tag}@example.com` }).returning();
const who = { workspaceId: ws!.id, userId: user!.id, role: "owner" as const };
afterAll(async () => {
  await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
  await db.delete(users).where(eq(users.id, user!.id));
});

async function fill() {
  // a prospect: no new-client automations run
  const c = await addClient(who, { name: `Northwind ${tag}`, stage: "prospect" });
  if (!c.ok) throw new Error(c.error);
  const p = await addContact(who, { name: "Sarah Lee", email: `sarah-${tag}@example.com`, clients: [{ client: c.client.slug, role: "Finance" }] });
  if (!p.ok) throw new Error(p.error);
  const j = await addProject(who, { name: "Website rebuild", client: c.client.slug });
  if (!j.ok) throw new Error(j.error);
  await db.insert(tasks).values({ workspaceId: ws!.id, title: "Draft the sitemap", clientId: c.client.id, projectId: j.project.id });
  return c.client;
}

test("a client that still has work can't be deleted underneath it", async () => {
  const c = await fill();
  await expect(db.delete(clients).where(eq(clients.id, c.id)).execute()).rejects.toThrow();
});

test("a whole business with clients, contacts, projects and tasks deletes in one go", async () => {
  const [other] = await db.insert(workspaces).values({ name: `records-test-gone-${tag}` }).returning();
  const c = await addClient({ ...who, workspaceId: other!.id }, { name: "Globex", stage: "prospect" });
  if (!c.ok) throw new Error(c.error);
  const p = await addProject({ ...who, workspaceId: other!.id }, { name: "Audit", client: c.client.slug });
  if (!p.ok) throw new Error(p.error);
  await addContact({ ...who, workspaceId: other!.id }, { name: "Ivy Chen", clients: [{ client: c.client.slug }] });
  await db.insert(tasks).values({ workspaceId: other!.id, title: "Send the letter", clientId: c.client.id, projectId: p.project.id });
  await db.delete(workspaces).where(eq(workspaces.id, other!.id));
  expect(await db.select().from(clients).where(eq(clients.workspaceId, other!.id))).toEqual([]);
});

test("a project's history names the new client and status, not ids or done-at", async () => {
  const a = await addClient(who, { name: `Contoso ${tag}`, stage: "prospect" });
  const b = await addClient(who, { name: `Fabrikam ${tag}`, stage: "prospect" });
  if (!a.ok || !b.ok) throw new Error("clients");
  const p = await addProject(who, { name: "Audit", client: a.client.slug });
  if (!p.ok) throw new Error(p.error);
  const u = await updateProject(who, p.project.slug, { client: b.client.slug, status: "done" }, true);
  if (!u.ok) throw new Error(u.error);
  const [last] = await historyOf(ws!.id, { kind: "project", id: p.project.id });
  expect(last!.changes.map((c) => c.field).sort()).toEqual(["client", "status"]);
  expect(last!.changes.find((c) => c.field === "client")!.to).toBe(b.client.name);
});

test("a contact's own fields: typed, named in history, cleared when the field goes", async () => {
  expect(await saveField(who, "contact", null, { name: "Birthday", type: "date" })).toBeNull();
  const c = await addContact(who, { name: `Ivy Chen ${tag}`, details: { Birthday: "1984-03-02" } });
  if (!c.ok) throw new Error(c.error);
  expect(c.contact.details).toEqual([{ key: "birthday", name: "Birthday", value: "1984-03-02" }]);
  const bad = await updateContact(who, c.contact.slug, { details: { Birthday: "soon" } }, true);
  expect(bad.ok).toBe(false);
  const u = await updateContact(who, c.contact.slug, { details: { Birthday: "1984-03-03" } }, true);
  if (!u.ok) throw new Error(u.error);
  const [last] = await historyOf(ws!.id, { kind: "contact", id: c.contact.id });
  expect(last!.changes).toEqual([{ field: "Birthday", from: "1984-03-02", to: "1984-03-03" }]);
  expect(await removeField(who, "contact", "Birthday")).toBeNull();
  const after = await findContact(ws!.id, c.contact.slug, true);
  expect(typeof after === "object" && after.details).toEqual([]);
});

test("a private client, its projects and its only contacts are left out for staff", async () => {
  const staff = { ...who, role: "member" as const };
  const c = await addClient(who, { name: `Initech ${tag}`, stage: "prospect" });
  const open = await addClient(who, { name: `Hooli ${tag}`, stage: "prospect" });
  if (!c.ok || !open.ok) throw new Error("clients");
  const only = await addContact(who, { name: `Bill Lumbergh ${tag}`, clients: [{ client: c.client.slug }] });
  const both = await addContact(who, { name: `Peter Gibbons ${tag}`, clients: [{ client: c.client.slug }, { client: open.client.slug }] });
  if (!only.ok || !both.ok) throw new Error("contacts");
  // what switching the client takes with it: its project and the contact at no other client (not the one at Hooli too)
  const before = await addProject(who, { name: "Audit", client: c.client.slug });
  if (!before.ok) throw new Error(before.error);
  const moving = await targets(ws!.id, "client", c.client.id, true);
  expect(moving.map((t) => t.kind + ":" + t.name).sort()).toEqual([`client:Initech ${tag}`, `contact:Bill Lumbergh ${tag}`, "project:Audit"]);
  // as setPrivate leaves them (its notes move needs git, not here)
  await db.update(clients).set({ private: true }).where(eq(clients.id, c.client.id));
  await db.update(contacts).set({ private: true }).where(eq(contacts.id, only.contact.id));
  // a new project for a private client is private with it
  const later = await addProject(who, { name: "Payroll", client: c.client.slug });
  if (!later.ok) throw new Error(later.error);
  expect(later.project.private).toBe(true);
  expect((await listClients(staff)).some((x) => x.id === c.client.id)).toBe(false);
  expect(typeof (await findClient(staff, c.client.slug, true))).toBe("string");
  expect((await listClients(who)).some((x) => x.id === c.client.id)).toBe(true);
  const seen = await listContacts(staff);
  expect(seen.some((x) => x.id === only.contact.id)).toBe(false);
  expect(seen.find((x) => x.id === both.contact.id)!.clients.map((k) => k.id)).toEqual([open.client.id]);
  expect((await listProjects(staff, { clientId: c.client.id })).length).toBe(0);
  expect((await listProjects(who, { clientId: c.client.id })).length).toBe(2);
  // a private project at a shared client isn't counted for staff
  const hidden = await addProject(who, { name: "Layoffs", client: open.client.slug, private: true });
  if (!hidden.ok) throw new Error(hidden.error);
  expect((await listClients(staff)).find((x) => x.id === open.client.id)!.activeProjects).toBe(0);
  expect((await listClients(who)).find((x) => x.id === open.client.id)!.activeProjects).toBe(1);
  // a manager sees a report's tasks, but not one for a private client; the report sees their own
  const [report] = await db.insert(users).values({ email: `report-${tag}@example.com` }).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: ws!.id, userId: user!.id, role: "member" },
    { workspaceId: ws!.id, userId: report!.id, role: "member", reportsTo: user!.id },
  ]);
  await db.insert(tasks).values([
    { workspaceId: ws!.id, title: "Secret", assigneeId: report!.id, clientId: c.client.id },
    { workspaceId: ws!.id, title: "Open", assigneeId: report!.id, clientId: open.client.id },
  ]);
  expect((await listTasks(staff)).map((t) => t.title).sort()).toEqual(["Open"]);
  expect((await listTasks({ ...staff, userId: report!.id })).map((t) => t.title).sort()).toEqual(["Open", "Secret"]);
  await db.delete(users).where(eq(users.id, report!.id));
});

test("sharing a client again shares only what went private with it; staff don't see private lines in its history", async () => {
  const staff = { ...who, role: "member" as const };
  expect(seesPrivate({ workspaceId: ws!.id })).toBe(false);
  const c = await addClient(who, { name: `Globex ${tag}`, stage: "prospect" });
  if (!c.ok) throw new Error(c.error);
  const own = await addProject(who, { name: "Merger", client: c.client.slug, private: true });
  const taken = await addProject(who, { name: "Audit", client: c.client.slug });
  if (!own.ok || !taken.ok) throw new Error("projects");
  expect((await historyOf(ws!.id, { clientId: c.client.id }, 30, false, staff)).some((h) => h.summary.includes("Merger"))).toBe(false);
  expect((await historyOf(ws!.id, { clientId: c.client.id }, 30, false, who)).some((h) => h.summary.includes("Merger"))).toBe(true);
  // notes moving needs git: only which rows each switch takes
  expect((await targets(ws!.id, "client", c.client.id, true)).map((t) => t.name).sort()).toEqual(["Audit", `Globex ${tag}`]);
  await db.update(clients).set({ private: true }).where(eq(clients.id, c.client.id));
  const seen = await listProjects(who, { clientId: c.client.id });
  expect(seen.map((p) => [p.name, p.private, p.privateBecause]).sort()).toEqual([["Audit", true, `Globex ${tag}`], ["Merger", true, null]]);
  expect((await targets(ws!.id, "client", c.client.id, false)).map((t) => t.name).sort()).toEqual(["Audit", `Globex ${tag}`]);
  // shared again: the one private on its own stays private
  await db.update(clients).set({ private: false }).where(eq(clients.id, c.client.id));
  expect((await listProjects(staff, { clientId: c.client.id })).map((p) => p.name)).toEqual(["Audit"]);
});

test("a team member who handles a private client sees it, its projects, contacts and tasks; others don't", async () => {
  const [mate] = await db.insert(users).values({ email: `handler-${tag}@example.com` }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: mate!.id, role: "member" });
  const handler = { workspaceId: ws!.id, userId: mate!.id, role: "member" as const };
  const other = { ...who, role: "member" as const };
  const c = await addClient(who, { name: `Soylent ${tag}`, stage: "prospect" });
  if (!c.ok) throw new Error("client");
  await db.insert(clientHandlers).values({ clientId: c.client.id, userId: mate!.id });
  const p = await addProject(who, { name: "Recipe", client: c.client.slug });
  const k = await addContact(who, { name: `Thorn ${tag}`, clients: [{ client: c.client.slug }] });
  if (!p.ok || !k.ok) throw new Error("records");
  await db.insert(tasks).values({ workspaceId: ws!.id, title: "Taste", assigneeId: user!.id, requesterId: user!.id, clientId: c.client.id });
  await db.update(clients).set({ private: true }).where(eq(clients.id, c.client.id));
  for (const [v, sees] of [[handler, true], [other, false]] as const) {
    expect((await listClients(v)).some((x) => x.id === c.client.id)).toBe(sees);
    expect((await listProjects(v, { clientId: c.client.id })).length).toBe(sees ? 1 : 0);
    expect((await listContacts(v)).some((x) => x.id === k.contact.id)).toBe(sees);
  }
  // their Emplio has them in its shared/ folder, not the owners' folder it doesn't have
  expect(notesAt(handler, "client", { slug: "soylent", private: true })).toBe("/work/shared/clients/soylent/index.md");
  expect(notesAt(who, "client", { slug: "soylent", private: true })).toBe("/work/restricted/clients/soylent/index.md");
  await db.delete(users).where(eq(users.id, mate!.id));
});

test("who gets which private files: handlers their client's, a project's lead just that project, meetings by their records", async () => {
  const [sarah] = await db.insert(users).values({ email: `sarah-${tag}@example.com`, name: `Sarah ${tag}` }).returning();
  const [raj] = await db.insert(users).values({ email: `raj-${tag}@example.com`, name: `Raj ${tag}` }).returning();
  await db.insert(workspaceMembers).values([sarah!, raj!].map((u) => ({ workspaceId: ws!.id, userId: u.id, role: "member" as const })));
  const asSarah = { workspaceId: ws!.id, userId: sarah!.id, role: "member" as const };
  const asRaj = { workspaceId: ws!.id, userId: raj!.id, role: "member" as const };
  const c = await addClient(who, { name: `Hooli ${tag}`, stage: "prospect", force: true });
  if (!c.ok) throw new Error(c.error);
  await db.insert(clientHandlers).values({ clientId: c.client.id, userId: sarah!.id });
  const led = await addProject(who, { name: `Tps ${tag}`, client: c.client.slug, lead: `raj-${tag}@example.com` });
  const other = await addProject(who, { name: `Printer ${tag}`, client: c.client.slug });
  if (!led.ok || !other.ok) throw new Error("projects");
  await db.update(clients).set({ private: true }).where(eq(clients.id, c.client.id));
  // Raj leads one project: he sees it (and its client's name), not the client or its other project
  expect((await listProjects(asRaj, { clientId: c.client.id })).map((p) => [p.name, p.client.name])).toEqual([[`Tps ${tag}`, `Hooli ${tag}`]]);
  expect((await listClients(asRaj)).some((x) => x.id === c.client.id)).toBe(false);
  const sarahs = await sharedWith(ws!.id, sarah!.id);
  expect(sarahs.folders.sort()).toEqual([`clients/${c.client.slug}`, `projects/${led.project.slug}`, `projects/${other.project.slug}`].sort());
  const rajs = await sharedWith(ws!.id, raj!.id);
  expect(rajs.folders).toEqual([`projects/${led.project.slug}`]);
  expect(rajs.test(`projects/${led.project.slug}/index.md`)).toBe(true);
  expect(rajs.test(`clients/${c.client.slug}/index.md`)).toBe(false);
  // a private task: who asked and who does it; not another team member, even one handling a shared client
  const [t] = await db.insert(tasks).values({ workspaceId: ws!.id, title: "Salary letter", assigneeId: sarah!.id, requesterId: user!.id, private: true }).returning();
  expect((await listTasks(asSarah)).some((x) => x.id === t!.id)).toBe(true);
  expect((await listTasks(asRaj)).some((x) => x.id === t!.id)).toBe(false);
  expect((await listTasks(who)).some((x) => x.id === t!.id && x.private)).toBe(true);
  // only who asked (or an admin) can unset it
  expect((await updateTask(asSarah, t!.id, { private: false })).ok).toBe(false);
  // meetings: a private client's goes to its handlers and the teammates in it; one private on its own, only to those in it
  const about = await addMeeting(who, { title: "Pricing call", on: "2026-11-20", client: c.client.slug, people: `Raj ${tag}, Gavin Belson` });
  const own = await addMeeting(who, { title: "Salary talk", on: "2026-11-21", people: `Sarah ${tag}`, private: true });
  const open = await addMeeting(who, { title: "Team lunch", on: "2026-11-22", people: `Raj ${tag}` });
  if (!about.ok || !own.ok || !open.ok) throw new Error(String([about, own, open].map((r) => !r.ok && r.error)));
  expect(about.meeting.hidden && about.meeting.path).toBe(`restricted/meetings/${about.meeting.slug}.md`);
  expect(about.meeting.others).toEqual(["Gavin Belson"]);
  const file = (m: { slug: string }) => `meetings/${m.slug}.md`;
  const [s2, r2] = [await sharedWith(ws!.id, sarah!.id), await sharedWith(ws!.id, raj!.id)];
  expect([s2.test(file(about.meeting)), s2.test(file(own.meeting)), s2.test(file(open.meeting))]).toEqual([true, true, false]);
  expect([r2.test(file(about.meeting)), r2.test(file(own.meeting))]).toEqual([true, false]);
  expect((await listMeetings(asRaj)).map((m) => m.title).sort()).toEqual(["Pricing call", "Team lunch"]);
  // only admins make one private; a teammate not in it can't change it
  expect((await addMeeting(asRaj, { title: "x", private: true })).ok).toBe(false);
  expect((await updateMeeting(asRaj, own.meeting.slug, { title: "y" })).ok).toBe(false);
  // what Sarah may change in company/: proposals, her own clients', projects' and meetings' notes
  const may = writableRegex(["northwind"], ["northwind-audit"], ["2026-11-22-team-lunch"]);
  expect(["inbox/x.md", "clients/northwind/index.md", "projects/northwind-audit/a.md", "meetings/2026-11-22-team-lunch.md"].every((p) => may.test(p))).toBe(true);
  expect(["clients/acme/index.md", "clients/northwind-2/index.md", "skillset/x/SKILL.md", "AGENT.md", "meetings/2026-11-22-team-lunchx.md", "meetings/other.md"].some((p) => may.test(p))).toBe(false);
  await db.delete(meetings).where(inArray(meetings.id, [about.meeting.id, own.meeting.id, open.meeting.id]));
  await db.delete(tasks).where(eq(tasks.id, t!.id));
  await db.delete(users).where(eq(users.id, sarah!.id));
  await db.delete(users).where(eq(users.id, raj!.id));
});

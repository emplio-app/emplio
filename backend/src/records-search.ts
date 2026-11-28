// Searching records: the clients, contacts, projects, services and meetings this person may see (their own lists'
// rules), archived ones too, whose fields hold every word, any case. For emplio search's "Records" part and the app's
// search box (GET /search/records).
// ponytail: loads the lists and filters in memory; a SQL search when a business has thousands of records
import type { FastifyInstance } from "fastify";
import type { RecordHit } from "@emplio/shared";
import { context } from "./auth";
import { listClients } from "./clients";
import { listContacts } from "./contacts";
import { listMeetings } from "./meetings";
import { listProjects } from "./projects";
import type { Viewer } from "./records";
import { listServices } from "./services";

const both = <T,>(list: (f: { archived?: boolean }) => Promise<T[]>) => Promise.all([list({}), list({ archived: true })]).then(([a, b]) => [...a, ...b]);
const line = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(", ");
const gone = (r: { archivedAt: string | null }) => (r.archivedAt ? "archived" : null);

export async function findRecords(v: Viewer, words: string[]): Promise<RecordHit[]> {
  const ws = words.map((w) => w.toLowerCase()).filter(Boolean);
  if (!ws.length) return [];
  const [cs, ks, ps, ss, ms] = await Promise.all([
    both((f) => listClients(v, f)),
    both((f) => listContacts(v, f)),
    both((f) => listProjects(v, f)),
    both((f) => listServices(v, f)),
    listMeetings(v, {}),
  ]);
  // every field's text, ids and dates left out so a word doesn't match them by chance
  const has = (r: object) => {
    const text = JSON.stringify(r, (k, x) => (k === "id" || k === "updatedAt" || k === "path" ? undefined : x)).toLowerCase();
    return ws.every((w) => text.includes(w));
  };
  return [
    ...cs.filter(has).map((c): RecordHit => ({ kind: "client", slug: c.slug, name: c.name, line: line(c.stage, gone(c)), href: `/clients/${c.slug}` })),
    ...ks.filter(has).map((k): RecordHit => ({ kind: "contact", slug: k.slug, name: k.name, line: line(k.title, k.email, k.phone, ...k.clients.map((c) => c.name), gone(k)), href: `/contacts?open=contacts/${k.slug}` })),
    ...ps.filter(has).map((p): RecordHit => ({ kind: "project", slug: p.slug, name: p.name, line: line(`for ${p.client.name}`, p.status, gone(p)), href: `/projects?open=projects/${p.slug}` })),
    ...ss.filter(has).map((s): RecordHit => ({ kind: "service", slug: s.slug, name: s.name, line: line(gone(s)), href: `/services?open=services/${s.slug}` })),
    ...ms.filter(has).map((m): RecordHit => ({ kind: "meeting", slug: m.slug, name: m.title, line: line(m.on, m.client?.name), href: `/knowledge?file=${encodeURIComponent(m.path)}` })),
  ];
}

// emplio search's "Records" part
export async function searchRecords(v: Viewer, words: string[]) {
  const out = (await findRecords(v, words)).map((h) => `${h.kind} ${h.slug}: ${line(h.name, h.line)}`);
  if (!out.length) return "(none)";
  return [...out.slice(0, 30), ...(out.length > 30 ? [`${out.length - 30} more not shown: emplio clients|contacts|projects|services|meetings list`] : [])].join("\n");
}

export async function recordSearchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string } }>("/search/records", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const hits = await findRecords({ workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role }, (req.query.q ?? "").slice(0, 200).split(/\s+/));
    return hits.slice(0, 20);
  });
}

import { and, asc, eq, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AddMemberRequest, TeamMember, UpdateMemberRequest } from "@emplio/shared";
import { context, normalizeEmail, type Ctx } from "./auth";
import { db } from "./db";
import { record } from "./activity";
import { users, workspaceMembers } from "./db/schema";
import { esc } from "./integrations";
import { sendEmail } from "./mail";

const canManage = (ctx: Pick<Ctx, "role">) => ctx.role === "owner" || ctx.role === "admin";

export const listTeam = (workspaceId: string): Promise<TeamMember[]> =>
  db
    .select({ id: users.id, name: users.name, email: users.email, role: workspaceMembers.role, reportsTo: workspaceMembers.reportsTo })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.createdAt));

// Add someone to the inviter's business and email them. Shared by the Team screen and the agent's `emplio team add`.
export async function addMember(
  ctx: Pick<Ctx, "workspaceId" | "workspaceName" | "userId" | "userName" | "role">,
  input: { email: string; name?: string; role?: "admin" | "member" },
): Promise<{ ok: true; member: TeamMember; emailed: boolean } | { ok: false; error: string }> {
  if (!canManage(ctx)) return { ok: false, error: "Only the owner or an admin can add people." };
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: `"${input.email}" isn't an email address.` };
  const name = input.name?.trim() || null;
  const role = input.role ?? "member";

  await db.insert(users).values({ email, name }).onConflictDoNothing();
  const user = (await db.query.users.findFirst({ where: eq(users.email, email) }))!;
  const memberships = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, user.id));
  if (memberships.some((m) => m.workspaceId === ctx.workspaceId)) return { ok: false, error: `${email} is already on the team.` };
  // ponytail: one business per person until there's a workspace switcher
  if (memberships.length) return { ok: false, error: `${email} already belongs to another business.` };

  await db.insert(workspaceMembers).values({ workspaceId: ctx.workspaceId, userId: user.id, role });
  // an invited person without a name yet gets the one the inviter gave
  if (name && !user.name) await db.update(users).set({ name }).where(eq(users.id, user.id));

  const login = `${process.env.FRONTEND_URL ?? "http://localhost:3000"}/login`;
  const hi = `Hi${name ? ` ${name.split(" ")[0]}` : ""},`;
  const said = `${ctx.userName} added you to ${ctx.workspaceName} on Emplio. Emplio works for the whole team: give it a job and it gets it done.`;
  const emailed = await sendEmail(email, `${ctx.userName} added you to ${ctx.workspaceName} on Emplio`, [hi, "", said, `Open Emplio and sign in with ${email}: ${login}`].join("\n"), {
    html: `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#262521;max-width:480px">
<p>${esc(hi)}</p><p>${esc(said)}</p>
<p style="margin:24px 0"><a href="${esc(login)}" style="background:#1f6b4e;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:600;display:inline-block">Open Emplio</a></p>
<p style="color:#77756f;font-size:13px">Sign in with this email address, ${esc(email)}.</p></div>`,
  });

  record({ workspaceId: ctx.workspaceId, userId: ctx.userId, kind: "team", summary: `Added ${name ?? user.name ?? email} <${email}> as ${role}` });
  return { ok: true, member: { id: user.id, name: name ?? user.name, email, role, reportsTo: null }, emailed };
}

// Change someone's role (or remove them, role null). The owner can't be changed, and nobody changes themselves.
// Shared by the Team screen and `emplio team role|remove`.
export async function changeMember(
  ctx: Pick<Ctx, "workspaceId" | "userId" | "role">,
  userId: string,
  role: "admin" | "member" | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!canManage(ctx)) return { ok: false, error: "Only the owner or an admin can change the team." };
  if (userId === ctx.userId) return { ok: false, error: "You can't change your own role or remove yourself." };
  const where = and(
    eq(workspaceMembers.workspaceId, ctx.workspaceId),
    eq(workspaceMembers.userId, userId),
    ne(workspaceMembers.role, "owner"),
  );
  const [row] = role
    ? await db.update(workspaceMembers).set({ role }).where(where).returning()
    : await db.delete(workspaceMembers).where(where).returning();
  if (!row) return { ok: false, error: "Not on the team (or it's the owner, who can't be changed)." };
  const them = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { name: true, email: true } });
  const person = them ? `${them.name ?? them.email} <${them.email}>` : userId;
  record({ workspaceId: ctx.workspaceId, userId: ctx.userId, kind: "team", summary: role ? `Made ${person} ${role}` : `Removed ${person} from the team` });
  return { ok: true };
}

// Who someone reports to (managerId), or nobody (null). Not the owner, not themselves, and never in a circle.
// Shared by the Team screen and `emplio team manager`.
export async function setManager(
  ctx: Pick<Ctx, "workspaceId" | "userId" | "role">,
  userId: string,
  managerId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!canManage(ctx)) return { ok: false, error: "Only the owner or an admin can change who reports to whom." };
  const team = await listTeam(ctx.workspaceId);
  const them = team.find((m) => m.id === userId);
  if (!them) return { ok: false, error: "Not on the team." };
  if (them.role === "owner") return { ok: false, error: "The owner doesn't report to anyone." };
  if (managerId === userId) return { ok: false, error: "Nobody reports to themselves." };
  const manager = managerId ? team.find((m) => m.id === managerId) : null;
  if (managerId && !manager) return { ok: false, error: "The manager isn't on the team." };
  // walk up from the new manager: reaching this person would make a circle
  for (let at = manager; at; at = team.find((m) => m.id === at!.reportsTo)) {
    if (at.id === userId) return { ok: false, error: `${manager!.name ?? manager!.email} already reports to ${them.name ?? them.email}, directly or through someone.` };
  }
  await db.update(workspaceMembers).set({ reportsTo: managerId }).where(and(eq(workspaceMembers.workspaceId, ctx.workspaceId), eq(workspaceMembers.userId, userId)));
  const label = (m: TeamMember) => `${m.name ?? m.email} <${m.email}>`;
  record({ workspaceId: ctx.workspaceId, userId: ctx.userId, kind: "team", summary: manager ? `${label(them)} now reports to ${label(manager)}` : `${label(them)} no longer reports to anyone` });
  return { ok: true };
}

export async function teamRoutes(app: FastifyInstance) {
  app.get("/team", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return listTeam(ctx.workspaceId);
  });

  app.post<{ Body: AddMemberRequest }>(
    "/team",
    {
      schema: {
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", maxLength: 254 },
            name: { type: "string", maxLength: 100 },
            role: { type: "string", enum: ["admin", "member"] },
          },
        },
      },
    },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      const added = await addMember(ctx, req.body);
      if (!added.ok) return reply.code(canManage(ctx) ? 400 : 403).send({ error: added.error });
      return added.member;
    },
  );

  app.patch<{ Params: { userId: string }; Body: UpdateMemberRequest }>(
    "/team/:userId",
    {
      schema: {
        body: {
          type: "object",
          minProperties: 1,
          properties: { role: { type: "string", enum: ["admin", "member"] }, reportsTo: { type: ["string", "null"], format: "uuid" } },
        },
      },
    },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      const changed = req.body.role ? await changeMember(ctx, req.params.userId, req.body.role) : { ok: true as const };
      if (!changed.ok) return reply.code(400).send({ error: changed.error });
      const managed = req.body.reportsTo !== undefined ? await setManager(ctx, req.params.userId, req.body.reportsTo) : changed;
      return managed.ok ? managed : reply.code(400).send({ error: managed.error });
    },
  );

  app.delete<{ Params: { userId: string } }>("/team/:userId", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const changed = await changeMember(ctx, req.params.userId, null);
    return changed.ok ? changed : reply.code(400).send({ error: changed.error });
  });
}

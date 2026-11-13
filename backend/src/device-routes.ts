// What the Emplio desktop app asks of this server: to be added as a device, listed, renamed and removed (the person's
// Settings), and the sockets it connects with. See devices.ts for what happens on them.
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { context } from "./auth";
import { db } from "./db";
import { devices } from "./db/schema";
import { attach, cdpTokenOk, deviceById, isOnline, notify, rpc, wsBase, type Socket } from "./devices";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const online = { get: deviceById };
const NAME = { type: "string", minLength: 1, maxLength: 80 } as const;

export async function deviceRoutes(app: FastifyInstance) {
  // The app, signed in, asks for a token to connect with. The same install asking again gets a new one (the old stops working).
  app.post<{ Body: { installId: string; name: string; platform: string } }>(
    "/devices",
    { schema: { body: { type: "object", required: ["installId", "name", "platform"], properties: { installId: { type: "string", minLength: 8, maxLength: 80 }, name: NAME, platform: { type: "string", maxLength: 40 } } } } },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      const token = newToken();
      const { installId, name, platform } = req.body;
      const [row] = await db
        .insert(devices)
        .values({ userId: ctx.userId, installId, name, platform, tokenHash: hash(token) })
        .onConflictDoUpdate({ target: [devices.userId, devices.installId], set: { name, platform, tokenHash: hash(token) } })
        .returning({ id: devices.id });
      return { id: row!.id, token };
    },
  );

  app.get("/devices", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const rows = await db.select().from(devices).where(eq(devices.userId, ctx.userId)).orderBy(devices.createdAt);
    return rows.map((d) => ({ id: d.id, name: d.name, platform: d.platform, online: isOnline(d.id), lastSeenAt: d.lastSeenAt }));
  });

  app.patch<{ Params: { id: string }; Body: { name: string } }>(
    "/devices/:id",
    { schema: { body: { type: "object", required: ["name"], properties: { name: NAME } } } },
    async (req, reply) => {
      const ctx = await context(req, reply);
      if (!ctx) return;
      const done = await db.update(devices).set({ name: req.body.name }).where(and(eq(devices.id, req.params.id), eq(devices.userId, ctx.userId))).returning({ id: devices.id });
      if (!done.length) return reply.code(404).send({ error: "No such computer" });
      return { ok: true };
    },
  );

  // Removing it signs the app out of this: it stops being used at once and its token no longer works.
  app.delete<{ Params: { id: string } }>("/devices/:id", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const done = await db.delete(devices).where(and(eq(devices.id, req.params.id), eq(devices.userId, ctx.userId))).returning({ id: devices.id });
    if (!done.length) return reply.code(404).send({ error: "No such computer" });
    online.get(req.params.id)?.socket.close(4001, "removed");
    return { ok: true };
  });

  app.get("/devices/connect", { websocket: true }, async (socket, req) => {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const [row] = token ? await db.select().from(devices).where(eq(devices.tokenHash, hash(token))) : [];
    if (!row) return socket.close(4001, "unknown device");
    attach({ id: row.id, userId: row.userId, name: row.name, platform: row.platform }, socket as unknown as Socket);
    await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, row.id)).catch(() => {});
    socket.on("close", () => void db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, row.id)).catch(() => {}));
  });

  // Chrome's own address book (/json/version, /json/list), with its addresses pointed back at this server
  app.get<{ Params: { t: string; "*": string } }>("/device-cdp/:t/json/*", async (req, reply) => {
    const ok = cdpTokenOk(req.params.t);
    const conn = ok && online.get(ok.deviceId);
    if (!ok || !conn) return reply.code(404).send({ error: "no such browser" });
    const r = await rpc<{ status: number; body: string }>(conn, "cdp.http", { key: ok.key, path: `/json/${req.params["*"]}` }, { timeoutMs: 15_000 }).catch(() => null);
    if (!r) return reply.code(502).send({ error: "the browser didn't answer" });
    return reply.code(r.status).type("application/json").send(r.body.replaceAll("ws://__CDP__", `${wsBase()}/device-cdp/${req.params.t}`));
  });

  // and the DevTools socket itself, any path of it (the browser's, or one page's)
  app.get<{ Params: { t: string; "*": string } }>("/device-cdp/:t/*", { websocket: true }, (socket, req) => {
    const ok = cdpTokenOk(req.params.t);
    const conn = ok && online.get(ok.deviceId);
    if (!ok || !conn) return socket.close();
    const id = randomBytes(8).toString("hex");
    conn.cdp.set(id, { data: (text) => socket.send(text), closed: () => socket.close() });
    notify(conn, "cdp.open", { key: ok.key, conn: id, path: `/${req.params["*"]}` });
    socket.on("message", (raw: unknown) => notify(conn, "cdp.send", { conn: id, data: String(raw) }));
    socket.on("close", () => {
      conn.cdp.delete(id);
      notify(conn, "cdp.close", { conn: id });
    });
  });
}

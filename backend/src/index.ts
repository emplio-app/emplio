import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { HealthResponse } from "@emplio/shared";
import { cloud, loadCloud } from "./cloud";
import { authRoutes } from "./auth";
import { chatRoutes } from "./chat";
import { browserRoutes } from "./browser";
import { loginRoutes } from "./logins";
import { setupRoutes } from "./setup";
import { fileRoutes } from "./files";
import { teamRoutes } from "./team";
import { integrationRoutes } from "./integrations";
import { gitProxyRoutes } from "./git-proxy";
import { automationRoutes, startAutomations } from "./automations";
import { searchRoutes } from "./search";
import { settingsRoutes } from "./settings";
import { modelRoutes } from "./models";
import { approvalRoutes } from "./approvals";
import { skillRoutes } from "./skills";
import { mentionRoutes } from "./mentions";
import { databaseRoutes } from "./database";
import { knowledgeRoutes } from "./knowledge";
import { mcpRoutes } from "./mcp";
import { startHeartbeat } from "./heartbeat";
import { jobRoutes, markOrphanedJobs } from "./jobs";
import { agentRoutes } from "./agents";
import { tooMany } from "./rate";
import { resumeCutOff } from "./resume";
import { channelRoutes } from "./channels";
import { telegram } from "./channels/telegram";
import { startTasks, taskRoutes } from "./tasks";
import { importRoutes } from "./imports";
import { madeRoutes } from "./made";
import { chargeSleptBoxes } from "./sandbox";
import { releases, version } from "./changelog";

// Emplio Cloud's own parts, when this checkout has the private cloud/ folder (cloud.ts)
if (await loadCloud()) console.log("Emplio Cloud parts loaded");

// A proxy on this machine, if there is one, says who's really asking
const app = Fastify({ logger: true, trustProxy: process.env.TRUST_PROXY ?? "loopback" });
// Per address, before a body is read. Not for the payment and app webhooks, which come from a few shared addresses and
// are signed, nor this machine's own requests. Generous: a whole office can share one address.
const MINUTE = 60_000;
app.addHook("onRequest", async (req, reply) => {
  const path = req.url.split("?")[0]!;
  if (path.startsWith("/webhooks/") || /^(::1|127\.|::ffff:127\.)/.test(req.ip)) return;
  const upload = req.method === "POST" && (path === "/uploads" || path === "/imports" || path === "/transcribe");
  if (tooMany(`ip:${req.ip}`, 1000, MINUTE) || (upload && tooMany(`upload:${req.ip}`, 30, MINUTE)))
    return reply.code(429).send({ error: "Too many requests. Wait a minute and try again." });
});
await app.register(cors, {
  // dev: allow any origin so the app works from other devices on the wifi
  origin: process.env.NODE_ENV === "production" ? process.env.FRONTEND_URL : true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  credentials: true,
});
await app.register(cookie);
await app.register(websocket);
await app.register(authRoutes);
await app.register(chatRoutes);
await app.register(browserRoutes);
await app.register(loginRoutes);
await app.register(setupRoutes);
await app.register(fileRoutes);
await app.register(teamRoutes);
await app.register(integrationRoutes);
await app.register(gitProxyRoutes);
await app.register(automationRoutes);
await app.register(knowledgeRoutes);
await app.register(databaseRoutes);
await app.register(mcpRoutes);
await app.register(searchRoutes);
await app.register(settingsRoutes);
await app.register(modelRoutes);
await app.register(approvalRoutes);
await app.register(skillRoutes);
await app.register(mentionRoutes);
await app.register(jobRoutes);
await app.register(agentRoutes);
await app.register(channelRoutes);
await app.register(taskRoutes);
await app.register(madeRoutes);
await app.register(importRoutes);
await app.register(cloud.browser.browserHostRoutes);
await app.register(cloud.storage.storageRoutes);
for (const routes of cloud.routes) await app.register(routes);

// open screens compare version with the one they first saw, and offer a refresh when it changes
app.get("/health", async (): Promise<HealthResponse> => ({ ok: true, version }));
app.get("/changelog", async () => releases);

await app.listen({ port: Number(process.env.PORT ?? 4000), host: "0.0.0.0" });
await startAutomations();
await markOrphanedJobs();
await resumeCutOff();
startHeartbeat();
startTasks();
// paid work measured after the fact (credit.ts): computer time once a box sleeps, browsers once they've stopped
setInterval(chargeSleptBoxes, 60_000);
for (const job of cloud.jobs) job();
await telegram.start();

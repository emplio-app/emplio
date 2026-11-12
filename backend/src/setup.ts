// Day one, like a new hire's: the owner briefs the agent, and it writes the business
// down in company/README.md and its own job in a "## Your job" section of company/AGENT.md. Whether that's done
// is kept here, per business, not guessed from the files: the agent marks it with `emplio setup done` (refused until
// both are written) or `emplio setup skip`, and the owner can run it again from Settings (`redo`). Until then owner and
// admin chats get the day-one note (onboarding(), last in the prompt); afterwards it costs nothing in the prompt.
import type { SetupStatus } from "@emplio/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { record } from "./activity";
import { context } from "./auth";
import { db } from "./db";
import { workspaces } from "./db/schema";
import { readFile } from "./gitea";

type Who = { workspaceId: string; userId: string; role: "owner" | "admin" | "member" };

export async function setupStatus(workspaceId: string): Promise<SetupStatus> {
  const w = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { setupOfferedAt: true, setupDoneAt: true, setupSkippedAt: true } });
  return {
    state: w?.setupDoneAt ? "done" : w?.setupSkippedAt ? "skipped" : "not-started",
    at: (w?.setupDoneAt ?? w?.setupSkippedAt)?.toISOString() ?? null,
  };
}

// a company file as the agent's chat sees it now: from its computer mid-reply, since what it writes there only
// reaches git when the reply ends
type Read = (file: string) => Promise<string | null>;

// What `done` needs: a README with more than Gitea's starter text, and the job section.
// ponytail: "more than the starter" is a length check; a real summary is far longer
export async function missing(workspaceId: string, read: Read = (f) => readFile(workspaceId, "company", f)) {
  const [readme, agent] = await Promise.all(["README.md", "AGENT.md"].map(read));
  const body = (readme ?? "").replace(/^# company\s*$/m, "").replace(/^Shared company files\s*$/m, "").trim();
  return [
    ...(body.length < 200 ? ["company/README.md: the business on one page (what it sells, to whom, prices, main clients and suppliers, who does what)"] : []),
    ...(!/^##\s+Your job/im.test(agent ?? "") ? ['a "## Your job" section at the end of company/AGENT.md (what you own, who you answer to, what you do alone, what needs asking)'] : []),
  ];
}

const set = (workspaceId: string, values: Partial<typeof workspaces.$inferInsert>) => db.update(workspaces).set(values).where(eq(workspaces.id, workspaceId));

export async function redo(w: Who) {
  // offered: it's been asked for, so the next chat just starts
  await set(w.workspaceId, { setupDoneAt: null, setupSkippedAt: null, setupOfferedAt: new Date() });
  record({ workspaceId: w.workspaceId, userId: w.userId, kind: "settings", summary: "Started setup again" });
}

// The day-one note for an owner or admin chat while setup isn't done or skipped; "" otherwise (and for staff,
// automations, tasks and check-ins). The first one ever also asks the agent to offer it, once per business.
export async function onboarding(w: Who & { name: string; automation?: boolean; task?: boolean }) {
  if (w.role === "member" || w.automation || w.task) return "";
  const row = await db.query.workspaces.findFirst({ where: eq(workspaces.id, w.workspaceId), columns: { setupOfferedAt: true, setupDoneAt: true, setupSkippedAt: true } });
  if (!row || row.setupDoneAt || row.setupSkippedAt) return "";
  if (!row.setupOfferedAt) await set(w.workspaceId, { setupOfferedAt: new Date() });
  return `## Not set up yet
Nobody has briefed you on the business or your job yet. ${
    row.setupOfferedAt
      ? `You've offered setup before: don't offer it again unprompted.`
      : `First do whatever ${w.name} asked, then end that reply with one extra line offering it, e.g. "I don't know much about the business yet. Got 5 minutes to brief me?" (this overrides "no offers" above).`
  }
- Setup is any time ${w.name} tells you about the business, whether they agreed to it or just started explaining. Ask in one message only for what you still don't know, at most five short questions: what the business does and for whom; who on the team handles what; what you should own (for example the leads inbox, collecting payments, the morning brief); what you may do on your own and what needs asking first; what the business is working toward this year and this quarter (its goals and current initiatives).
- When setup starts (they agreed, or opened with "Let's do the setup"), open that reply by introducing yourself in two or three short lines: you're Emplio, their AI employee, with your own computer and browser, working in their apps and on their phone, any time of day, and asking before anything risky or that speaks for the business. Then the questions.
- Look around yourself too, before asking: a website they gave (\`emplio web read <url>\`), files they attached, the team list, the connected apps, recent email and Drive files if connected. Don't ask what those already answered.
- When you learn the business's name, if it's still called "${w.name}'s workspace" (or another placeholder), rename it: \`emplio settings set name "<its name>"\`.
- If the business isn't in India, change the India line in company/AGENT.md to its country, currency and formats.
- Once you know enough, write company/README.md (the business on one page: what it sells, to whom, prices, main clients and suppliers, who does what) and a "## Your job" section at the end of company/AGENT.md (what you own, who you answer to, what you do alone, what needs asking; anything you weren't told: a sensible default marked "(assumed)"), the goals they gave in company/goals.md (under its headings; leave out what they didn't say), and facts in company/knowledge/. Then run \`emplio setup done\` (it says what's still missing) and show ${w.name} a few lines on what you wrote.
- If they say not now or don't want it: \`emplio setup skip\`. They can start it again from Settings.`;
}

const USAGE = `usage: emplio setup status       is the business set up (briefed, README and your job written)
       emplio setup done         mark setup finished (refused until company/README.md and "## Your job" are written)
       emplio setup skip         the owner doesn't want it now (they can start it again in Settings)
       emplio setup redo         start it again, to add to what you were told`;

export async function setupCommand(w: Who, args: string[], read?: Read) {
  const [sub] = args;
  if (sub === "status" || !sub) {
    const s = await setupStatus(w.workspaceId);
    const gaps = s.state === "done" ? [] : await missing(w.workspaceId, read);
    return `${s.state}${s.at ? ` (${s.at.slice(0, 10)})` : ""}${gaps.length ? `\nstill to write:\n- ${gaps.join("\n- ")}` : ""}`;
  }
  if (!["done", "skip", "redo"].includes(sub)) return USAGE;
  if (w.role === "member") return "error: only the owner or an admin's chat can change setup";
  if (sub === "redo") {
    await redo(w);
    return "setup started again: ask what's changed or missing, update company/README.md and \"## Your job\", then emplio setup done";
  }
  if (sub === "skip") {
    await set(w.workspaceId, { setupSkippedAt: new Date(), setupDoneAt: null });
    record({ workspaceId: w.workspaceId, userId: w.userId, kind: "settings", summary: "Skipped setup" });
    return "skipped; it won't be offered again (the owner can start it in Settings)";
  }
  const gaps = await missing(w.workspaceId, read);
  if (gaps.length) return `error: not yet. Still to write:\n- ${gaps.join("\n- ")}`;
  await set(w.workspaceId, { setupDoneAt: new Date(), setupSkippedAt: null });
  record({ workspaceId: w.workspaceId, userId: w.userId, kind: "settings", summary: "Finished setup" });
  return "setup done";
}

export async function setupRoutes(app: FastifyInstance) {
  app.get("/setup", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    return setupStatus(ctx.workspaceId);
  });

  // Settings' "Brief your AI employee": the web app then opens a new chat that starts it
  app.post("/setup/redo", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    if (ctx.role === "member") return reply.code(403).send({ error: "Only the owner or an admin can do this" });
    await redo(ctx);
    return setupStatus(ctx.workspaceId);
  });
}

// Runs a job's own instructions (../emplio.ts jobSystem: the shared prompt, src/jobs.ts RULES, its agent, its job
// card) at the end of its work: does it check before calling it done, and report what's true, in shape. The
// server's checks (src/checks.ts) are replayed once, as the app would send them back.
// `bun run eval evals/job-report` in backend.
import { MODEL_SETS } from "@emplio/shared";
import { Eval } from "braintrust";
import { appendFileSync } from "node:fs";
import type { Case } from "./cases";
import { scorers, statusIn, type Input, type Output } from "./scorers";

const app = () => import("../emplio");

async function task(input: Input): Promise<Output> {
  const { reply, pretend, person } = await app();
  const { FROM_EMPLIO } = await import("@emplio/shared");
  const { jobCard } = await import("../../src/jobs");
  const { badEnding, shapeProblem, doneProblem, openSteps, statusOf } = await import("../../src/checks");
  const { chatOf, JOB_WORLD } = await import("./cases");
  const plan = (input.plan ?? []).map(([text, done]) => ({ text, status: done ? ("done" as const) : ("todo" as const) }));
  const card = jobCard([{ role: "user", parts: [{ type: "text", text: FROM_EMPLIO + input.brief }] }], plan);
  const job = { agent: input.agent, card };
  const standIn = (command: string) => {
    // a tick on its checklist, as the server keeps it
    for (const n of /\bemplio plan done\s+([\d\s,]+)/.exec(command)?.[1]?.match(/\d+/g) ?? []) if (plan[+n - 1]) plan[+n - 1]!.status = "done";
    if (/\bemplio plan done\s*$/.test(command)) for (const s of plan) s.status = "done";
    // an answer with a third part holds only once a command matching it has run (a read-back after the send)
    const now = [...(input.world ?? []), ...JOB_WORLD].filter(([, , after]) => !after || ran.some((c) => new RegExp(after).test(c)));
    ran.push(command);
    return pretend(command, now.map(([words, out]) => [words, out] as [string, string]));
  };
  const ran: string[] = [];
  const chat = chatOf(input as Case);
  // a job has 250 steps a run (src/jobs.ts JOB_MAX_STEPS): enough here that the step limit doesn't end it mid-work
  const first = await reply({}, chat, standIn, 16, false, undefined, job);
  const firstReport = first.last ?? "";
  // the server's checks, once (src/jobs.ts began)
  const asked = statusIn(firstReport, first.commands) === "question";
  const note =
    badEnding({ text: firstReport, reasoned: false }) ??
    (asked ? null : shapeProblem(firstReport) ?? doneProblem(firstReport, { lastFailed: null, askedBefore: false }));
  let said = first;
  if (note) {
    const again = await reply({}, [...chat, ...(first.messages ?? []), person(FROM_EMPLIO + note)], standIn, 16, false, undefined, job);
    said = { ...again, commands: [...first.commands, ...again.commands] };
  }
  // after a Done report with checklist steps unticked, the quiet follow-up (src/jobs.ts): a new report only if it writes one
  const open = plan.filter((s) => s.status !== "done").map((s) => s.text);
  if (!note && !asked && statusOf(firstReport) === "done" && open.length) {
    const after = await reply({}, [...chat, ...(first.messages ?? []), person(FROM_EMPLIO + openSteps(open))], standIn, 16, false, undefined, job);
    if (statusOf(after.last ?? "")) said = { ...after, commands: [...first.commands, ...after.commands] };
    else said = { ...first, commands: [...first.commands, ...after.commands] };
  }
  const output = { ...said, report: said.last ?? "", first: firstReport, sentBack: note };
  if (process.env.EVAL_DUMP) appendFileSync(process.env.EVAL_DUMP, `${JSON.stringify({ name: input.name, category: input.category, output })}\n`);
  return output;
}

Eval<Input, Output, Case["expect"]>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "job-report",
  data: async () =>
    (await import("./cases")).cases().map((c) => ({
      input: { name: c.name, category: c.category, agent: c.agent, brief: c.brief, plan: c.plan, done: c.done, world: c.world },
      expected: c.expect,
      metadata: { name: c.name, category: c.category, source: c.source },
      tags: [c.category],
    })),
  task,
  scores: scorers,
  trialCount: Number(process.env.EVAL_TRIALS) || 3,
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY) || 24,
  metadata: { behaviour: "job-report", model: process.env.EVAL_MODEL || MODEL_SETS.save.jobModel },
});

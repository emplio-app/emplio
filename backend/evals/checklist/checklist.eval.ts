// Does a job tick its checklist as it goes, not all at the end? Live (Nov 24): of 56 jobs with a checklist, 18
// ticked everything in one go before the report and 5 never ticked. The person watches that list fill in.
// Runs a job's own instructions (../emplio.ts jobSystem, src/jobs.ts RULES) from its brief to its report, with the
// server's 10-command reminder (src/stuck.ts progressGuard) and the step field's ticking (src/plan.ts reachStep).
// `bun run evals checklist` in backend.
import { MODEL_SETS } from "@emplio/shared";
import type { PlanStep } from "@emplio/shared";
import { Eval } from "braintrust";
import { appendFileSync } from "node:fs";
import { cases, type Case } from "./cases";

type Output = { commands: number; ticks: number[]; steps: number; done: number; report: string };

// the words after "emplio plan set": quoted args, or one step a line from a heredoc
const stepsOf = (command: string) => {
  const rest = command.slice(command.search(/emplio plan set/) + 15);
  const here = /<<-?\s*'?(\w+)'?\n([\s\S]*?)\n\1/.exec(rest);
  if (here) return here[2]!.split("\n").map((s) => s.trim()).filter(Boolean);
  return [...rest.split("\n")[0]!.matchAll(/'((?:[^']|'\\'')*)'|"([^"]*)"/g)].map((m) => (m[1] ?? m[2]!).replace(/'\\''/g, "'"));
};

// the app's files, loaded once when first needed: cases starting together mustn't each import them (a half-loaded
// module throws "Cannot access ... before initialization")
let app: Promise<[typeof import("../emplio"), typeof import("@emplio/shared"), typeof import("../../src/jobs"), typeof import("../../src/stuck"), typeof import("../../src/chat"), typeof import("../job-report/cases")]> | undefined;
const load = () => (app ??= (async () => [await import("../emplio"), await import("@emplio/shared"), await import("../../src/jobs"), await import("../../src/stuck"), await import("../../src/chat"), await import("../job-report/cases")] as const)() as never);

export async function task(c: Case): Promise<Output> {
  const [{ reply, pretend, person }, { FROM_EMPLIO }, { jobCard }, { progressGuard }, { notCounted }, { JOB_WORLD }] = await load();
  let plan: PlanStep[] = [];
  const guard = progressGuard(null);
  // after each counted command, how many steps were ticked
  const ticks: number[] = [];
  const done = () => plan.filter((s) => s.status === "done").length;
  const standIn = (command: string, _step: number, tick?: number) => {
    let moved = false;
    if (/\bemplio plan set\b/.test(command)) (plan = stepsOf(command).map((text) => ({ text: text.replace(/^\[x\]\s*/i, ""), status: /^\[x\]/i.test(text) ? "done" : "todo" }))), (moved = true);
    const nums = /\bemplio plan done\b([^\n]*)/.exec(command)?.[1]?.match(/\d+/g);
    if (/\bemplio plan done\b/.test(command)) {
      for (const [i, s] of plan.entries()) if (!nums?.length || nums.includes(String(i + 1))) s.status = "done";
      moved = true;
    }
    // the step field: the checklist moves to it, ticking the ones before (src/plan.ts reachStep)
    if (tick && plan.length && !notCounted(command)) {
      const before = done();
      for (const [i, s] of plan.entries()) if (i < tick - 1) s.status = "done";
      if (done() !== before) moved = true;
    }
    const counted = !notCounted(command);
    const note = guard.check(moved ? plan.map((s) => ({ ...s })) : null, counted);
    if (counted) ticks.push(done());
    const out = /\bemplio plan\b/.test(command) ? "Checklist saved." : pretend(command, [...c.world, ...JOB_WORLD]);
    return note ? `${out}\n\n${note}` : out;
  };
  const card = jobCard([{ role: "user", parts: [{ type: "text", text: FROM_EMPLIO + c.brief }] }], []);
  const said = await reply({}, [person(FROM_EMPLIO + c.brief)], standIn, 40, false, undefined, { agent: c.agent, card });
  const output = { commands: ticks.length, ticks, steps: plan.length, done: done(), report: said.last ?? "" };
  if (process.env.EVAL_DUMP) appendFileSync(process.env.EVAL_DUMP, `${JSON.stringify({ name: c.name, output })}\n`);
  return output;
}

// Ticked as it went: the first tick comes before the last third of its commands, and the list moved at least twice
// (or, for a short list, before its last command). Ticking everything in one go at the end scores 0.
export function asItGoes({ output }: { output: Output }) {
  const { ticks, steps } = output;
  const n = ticks.length;
  if (!steps || n < 3) return { name: "as_it_goes", score: 0, metadata: { why: steps ? "too few commands" : "no checklist" } };
  const first = ticks.findIndex((t) => t > 0);
  const moves = ticks.filter((t, i) => i > 0 && t > ticks[i - 1]!).length + (ticks[0]! > 0 ? 1 : 0);
  const ok = first >= 0 && first < (n * 2) / 3 && moves >= Math.min(2, steps - 1);
  return { name: "as_it_goes", score: ok ? 1 : 0, metadata: { ticks: ticks.join(" "), steps } };
}
export const allTicked = ({ output }: { output: Output }) => ({ name: "all_ticked", score: output.steps > 0 && output.done === output.steps ? 1 : 0 });

Eval<Case, Output, null>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "checklist",
  data: async () => cases.map((c) => ({ input: c, expected: null, metadata: { name: c.name } })),
  task: async (c) => {
    try {
      return await task(c);
    } catch (e) {
      appendFileSync(".evals/checklist-errors.log", `${String((e as Error)?.stack ?? e)}\n`);
      throw e;
    }
  },
  scores: [asItGoes, allTicked],
  trialCount: Number(process.env.EVAL_TRIALS) || 3,
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY) || 12,
  metadata: { behaviour: "checklist", model: process.env.EVAL_MODEL || MODEL_SETS.save.jobModel },
});

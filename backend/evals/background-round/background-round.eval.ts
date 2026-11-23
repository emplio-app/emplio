// Runs a round of the background agent, on its own instructions (src/heartbeat.ts) and model, over readers' notes,
// what changed, the task list and the memory files over their limit, and marks what it did. `bun run eval
// evals/background-round` in backend; see ../README.md.
import { MODEL_SETS } from "@emplio/shared";
import { Eval } from "braintrust";
import { appendFileSync } from "node:fs";
import type { Said } from "../emplio";
import { cases, type Case } from "./cases";
import { rewriteOf, scorers } from "./scorers";

// The app's files are loaded when first needed, not at the top (hand-off/hand-off.eval.ts says why), and once.
let app: Promise<[typeof import("../emplio"), typeof import("../../src/heartbeat")]> | undefined;
const load = () => (app ??= Promise.all([import("../emplio"), import("../../src/heartbeat")]));

const JOURNAL = "# Background agent's journal\n\n## Open matters\n(nothing open)\n\n## Tried\n(nothing yet)";
const GOALS = "# Goals\n\n## Grow online orders to 40% of sales by March\n## Collect every invoice within 30 days";
// the server refuses the browser in background rounds (src/sandbox.ts runBash), in these words
const BROWSER = /\b(emplio|ez)["']?[\s,.]+["']?browser\b/;
const REFUSED = 'error: background rounds don\'t use the browser. Add a task for it instead: `emplio tasks add "<what to check on the site>" --to ai --due <when>`.';

type Input = Pick<Case, "notes" | "round" | "changes" | "tasks" | "goals" | "tooLong"> & { world: [string, string][] };

Eval<Input, Said, Case["expect"]>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "background-round",
  // EVAL_ONLY=<words>: only the cases whose name has them
  data: () =>
    cases.filter((c) => !process.env.EVAL_ONLY || c.name.includes(process.env.EVAL_ONLY)).map((c) => ({
      input: { notes: c.notes, world: c.world ?? [], round: c.round, changes: c.changes, tasks: c.tasks, goals: c.goals, tooLong: c.tooLong },
      expected: c.expect,
      metadata: { name: c.name, category: c.category, source: c.source },
      tags: [c.category],
    })),
  task: async ({ notes, world, round, changes, tasks, goals, tooLong }, { metadata, expected }) => {
    const [{ reply, pretend, person }, { backgroundBrief, instructions }] = await load();
    const brief = backgroundBrief({
      name: "Kaveri Home Furnishings",
      chat: "ab12cd34",
      today: "2026-11-10",
      goals: goals ?? GOALS,
      journal: JOURNAL,
      notes,
      changes: changes ?? (notes === "(nothing)" ? "" : "- new readers' notes on people's chats (below)"),
      tooLong,
    });
    const message = `${instructions(round?.kind ?? "check-in", null, tasks ?? "(no tasks)", "Asia/Kolkata", { daily: round?.daily, weekly: round?.weekly })}\n\n${brief}`;
    // every command gets a believable result (nothing is saved yet, nothing new came in), up to 14 steps
    // a person's file rewritten is what showing it gives afterwards, as on the server (src/reader.ts personCommand)
    let rewritten: string | null = null;
    const seen: string[] = [];
    const standIn = (command: string) => {
      if (BROWSER.test(command)) return REFUSED;
      seen.push(command);
      const now = rewriteOf(seen, "meera@kaveri.example", "prefer");
      if (now !== null && now !== rewritten && /^\s*["']?emplio person\b/.test(command)) {
        rewritten = now;
        return `Rewrote Meera's preferences.md: ${now.split("\n").length} lines, ${now.length} characters.`;
      }
      rewritten = now ?? rewritten;
      if (rewritten && /^\s*emplio person \S+\s*$/.test(command)) return `== profile.md\nRuns the shop.\n\n== preferences.md\n${rewritten}`;
      if (rewritten && /me\/preferences\.md/.test(command) && /^\s*(cat|head|wc)\b/.test(command)) return rewritten;
      // the task list it was given is what the tasks commands show
      if (tasks && /^\s*emplio tasks (list|search|show)\b/.test(command)) return tasks;
      return pretend(command, world);
    };
    // the weekly review digs into the numbers: more room than a round's usual 14 steps
    const said = await reply({}, [person(message)], standIn, round?.weekly ? 20 : 14, true);
    // EVAL_DUMP=<file>: each try's case, answer and expectation, one JSON line each
    if (process.env.EVAL_DUMP) appendFileSync(process.env.EVAL_DUMP, `${JSON.stringify({ name: (metadata as { name: string }).name, expected, output: { text: said.text, commands: said.commands, steps: said.steps, cost: said.usage?.cost } })}\n`);
    return said;
  },
  scores: scorers,
  trialCount: Number(process.env.EVAL_TRIALS) || 3,
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY) || 24,
  metadata: { behaviour: "background-round", model: process.env.EVAL_MODEL || MODEL_SETS.save.backgroundModel },
});

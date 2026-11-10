// Runs a round of the background agent, on its own instructions (src/heartbeat.ts) and model, over readers' notes,
// and marks where it put each thing. `bun run eval evals/background-round` in backend; see ../README.md.
import { MODEL_SETS } from "@emplio/shared";
import { Eval } from "braintrust";
import type { Said } from "../emplio";
import { cases, type Case } from "./cases";
import { scorers } from "./scorers";

// The app's files are loaded when first needed, not at the top (hand-off/hand-off.eval.ts says why), and once.
let app: Promise<[typeof import("../emplio"), typeof import("../../src/heartbeat")]> | undefined;
const load = () => (app ??= Promise.all([import("../emplio"), import("../../src/heartbeat")]));

const JOURNAL = "# Background agent's journal\n\n## Open matters\n(nothing open)\n\n## Tried\n(nothing yet)";
const GOALS = "# Goals\n\n## Grow online orders to 40% of sales by March\n## Collect every invoice within 30 days";

Eval<{ notes: string }, Said, Case["expect"]>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "background-round",
  data: () => cases.map((c) => ({ input: { notes: c.notes }, expected: c.expect, metadata: { name: c.name, category: c.category, source: c.source }, tags: [c.category] })),
  task: async ({ notes }) => {
    const [{ reply, pretend, person }, { backgroundBrief, instructions }] = await load();
    const round = `${instructions("check-in", null, "(no tasks)", "Asia/Kolkata")}\n\n${backgroundBrief({ name: "Kaveri Home Furnishings", chat: "ab12cd34", today: "2026-11-10", goals: GOALS, journal: JOURNAL, notes })}`;
    // every command gets a believable result (nothing is saved yet, nothing new came in), up to 14 steps
    return reply({}, [person(round)], pretend, 14, true);
  },
  scores: scorers,
  trialCount: 3,
  maxConcurrency: 6,
  metadata: { behaviour: "background-round", model: process.env.EVAL_MODEL || MODEL_SETS.default.backgroundModel },
});

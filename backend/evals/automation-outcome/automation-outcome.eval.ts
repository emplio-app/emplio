// Runs the end of an automation's run on its own instructions (src/automations.ts runMessage) and model, and marks
// whether the run comes out failed exactly when its work didn't get done (#244). `bun run eval
// evals/automation-outcome` in backend; see ../README.md.
import { MODEL_SETS } from "@emplio/shared";
import { Eval } from "braintrust";
import { appendFileSync } from "node:fs";
import type { ModelMessage } from "ai";
import type { World } from "../emplio";
import type { Case } from "./cases";
import { scorers, type Output } from "./scorers";

// The app's files are loaded when first needed, not at the top (hand-off/hand-off.eval.ts says why).
const app = () => Promise.all([import("../emplio"), import("../../src/automations")]);

type Input = { automation: string; chat: ModelMessage[]; world: World };

Eval<Input, Output, Case["expect"]>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "automation-outcome",
  data: async () =>
    (await (await import("./cases")).cases())
      .filter((c) => !process.env.EVAL_ONLY || c.name.includes(process.env.EVAL_ONLY))
      .map((c) => ({ input: { automation: c.automation, chat: c.chat, world: c.world ?? [] }, expected: c.expect, metadata: { name: c.name, category: c.category, source: c.source }, tags: [c.category] })),
  // it may try again (hand the work back, run the step again) before it ends: each command gets the case's answer
  task: async ({ automation, chat, world }, { metadata, expected }) => {
    const [{ reply, pretend }, { outcome }] = await app();
    const said = await reply({ agents: ["- LinkedIn Outreach (agents/linkedin-outreach, light): Sends LinkedIn connection invites", "- Order Keeper (agents/order-keeper, light): Keeps the Orders sheet up to date"] }, chat, (command) => pretend(command, world), 6, automation);
    const out = { ...said, outcome: outcome(null, said.last ?? null) };
    // EVAL_DUMP=<file>: each try's case, answer and expectation, one JSON line each
    if (process.env.EVAL_DUMP) appendFileSync(process.env.EVAL_DUMP, `${JSON.stringify({ name: (metadata as { name: string }).name, expected, last: said.last, commands: said.commands, status: out.outcome.status })}\n`);
    return out;
  },
  scores: scorers,
  trialCount: Number(process.env.EVAL_TRIALS) || 3,
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY) || 24,
  metadata: { behaviour: "automation-outcome", model: process.env.EVAL_MODEL || MODEL_SETS.save.backgroundModel },
});

// Runs the card writer the app uses (src/next-step.ts) over every case and marks what comes back.
// `bun run eval evals` in backend; see ../README.md.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { Eval } from "braintrust";
import { NEXT_STEP_MODEL, NEXT_STEP_RULES, writeNextStep, type Turn } from "../../src/next-step";
import { cases, type Case } from "./cases";
import { scorers, type Output } from "./scorers";

// EVAL_MODEL tries another model against the same cases without touching the app
const model = process.env.EVAL_MODEL || NEXT_STEP_MODEL;
const llm = createOpenRouter()(model);

Eval<Turn[], Output, Case["expect"]>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "next-step-card",
  data: () => cases.map((c) => ({ input: c.chat, expected: c.expect, metadata: { name: c.name, category: c.category, source: c.source }, tags: [c.category] })),
  task: (chat) => writeNextStep(chat, llm),
  scores: scorers,
  // the model doesn't answer the same way twice: a rule holds when it holds on every try
  trialCount: 3,
  maxConcurrency: 8,
  metadata: { behaviour: "next-step-card", model, rules: NEXT_STEP_RULES },
});

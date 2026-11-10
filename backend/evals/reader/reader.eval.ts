// Runs the reader's own instructions (src/reader.ts PROMPT) over every case and marks the note it writes.
// `bun run eval evals/reader` in backend; see ../README.md.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { MODEL_SETS } from "@emplio/shared";
import { generateText } from "ai";
import { Eval } from "braintrust";
import { cases, type Case } from "./cases";
import { scorers } from "./scorers";

const model = process.env.EVAL_MODEL || MODEL_SETS.save.summaryModel;
// The app's files are loaded when first needed, not at the top (hand-off/hand-off.eval.ts says why), and once:
// cases that start together must all wait for the same load, or the late ones get it half-ready.
let app: Promise<typeof import("../../src/reader")> | undefined;
const reader = () => (app ??= import("../../src/reader"));

Eval<{ title: string; chat: string }, string, Case["expect"]>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "reader",
  data: () => cases.map((c) => ({ input: { title: c.title, chat: c.chat }, expected: c.expect, metadata: { name: c.name, category: c.category, source: c.source }, tags: [c.category] })),
  task: async ({ title, chat }) => {
    const { PROMPT } = await reader();
    const { text } = await generateText({ model: createOpenRouter()(model), system: PROMPT("Meera", "owner"), prompt: [`Chat "${title}"`, "", "The new part:", chat].join("\n") });
    return text.trim();
  },
  scores: scorers,
  trialCount: 3,
  maxConcurrency: 8,
  metadata: { behaviour: "reader", model },
});

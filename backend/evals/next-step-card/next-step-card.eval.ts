// Runs the card writer the app uses (src/next-step.ts) over every case and marks what comes back. As in the app,
// it's written on Emplio's own request: the app's instructions for a made-up business (../emplio.ts), the chat,
// the commands of the last reply, on the chat model (Save money: Haiku). `bun run eval evals/next-step-card` in backend.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { Eval } from "braintrust";
import type { Case } from "./cases";
import { scorers, type Output } from "./scorers";

const app = Promise.all([import("../emplio"), import("../../src/next-step"), import("./cases"), import("../../src/chat")]);

Eval<Case, Output, Case["expect"]>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "next-step-card",
  data: async () => (await app)[2].cases.map((c) => ({ input: c, expected: c.expect, metadata: { name: c.name, category: c.category, source: c.source }, tags: [c.category] })),
  task: async (c) => {
    const [{ CHAT_MODEL, CODE_MODE, emplio, person, ran, system }, { writeNextStep }, , chat] = await app;
    // the reply's tool, as definitions only (nothing runs): history with tool calls needs it
    const tools: ToolSet = CODE_MODE ? { python: tool({ description: chat.PYTHON_DESCRIPTION, inputSchema: chat.pythonInput }) } : { bash: tool({ description: chat.BASH_DESCRIPTION, inputSchema: chat.bashInput }) };
    const messages: ModelMessage[] = c.chat.flatMap((t, i) =>
      t.role === "user" ? [person(t.text)] : [...(i === c.chat.length - 1 ? (c.work ?? []).flatMap((w) => ran(w.description, w.command, w.output)) : []), emplio(t.text)],
    );
    return writeNextStep({ model: createOpenRouter()(CHAT_MODEL), tools, providerOptions: {} }, system({}, false).join("\n\n"), messages);
  },
  scores: scorers,
  // the model doesn't answer the same way twice: a rule holds when it holds on every try
  trialCount: 3,
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY) || 24,
  metadata: { behaviour: "next-step-card", model: process.env.EVAL_MODEL || "save chat model" },
});

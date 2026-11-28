// Runs Emplio's own instructions (../emplio.ts) for the made-up firm (../client-work/firm.ts) over work inside
// processes already going, and marks which run or task it moved, and how. `bun run eval evals/process-steps` in
// backend; see ../README.md.
import { MODEL_SETS } from "@emplio/shared";
import { Eval } from "braintrust";
import { appendFileSync } from "node:fs";
import type { Said } from "../emplio";
import type { Case } from "./cases";
import { marks, scorers, type Input } from "./scorers";

async function work({ business, chat }: Input, name: string): Promise<Said> {
  const { reply, pretend, counted, memory } = await import("../emplio");
  const remember = memory();
  const WORLD = await (await import("../client-work/firm")).world();
  const firm = await import("../client-work/firm");
  const check = await firm.checker();
  const { longRunNote, notCounted, refusal, remindAt, skillNote } = await import("../../src/chat");
  const count = counted();
  const said = await reply(
    business,
    chat,
    (command, step) => {
      if (/\bemplio (hand|ask)\b/.test(command)) return null;
      const nth = count(step, !notCounted(command));
      const refused = refusal(command, nth);
      if (refused) return refused;
      const result = [remember.answer(command, check(command) ?? firm.search(command) ?? pretend(command, WORLD)), skillNote(nth, command)].filter(Boolean).join("\n\n");
      return nth && remindAt(nth) ? `${result}\n\n${longRunNote(nth, false)}` : result;
    },
    12,
  );
  if (process.env.EVAL_DUMP) {
    const c = (await (await import("./cases")).cases()).find((x) => x.name === name)!;
    appendFileSync(process.env.EVAL_DUMP, `${JSON.stringify({ name, category: c.category, marks: await marks({ input: { business, chat }, output: said, expected: c.expect }), commands: said.commands, text: said.text })}\n`);
  }
  return said;
}

Eval<Input, Said, Case["expect"]>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "process-steps",
  data: async () =>
    (await (await import("./cases")).cases()).map((c) => ({ input: { business: c.business, chat: c.chat }, expected: c.expect, metadata: { name: c.name, category: c.category, source: c.source }, tags: [c.category] })),
  task: (input, { metadata }) => work(input, (metadata as { name: string }).name),
  scores: scorers,
  trialCount: Number(process.env.EVAL_TRIALS) || 3,
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY) || 24,
  metadata: { behaviour: "process-steps", model: process.env.EVAL_MODEL || MODEL_SETS.save.chatModel },
});

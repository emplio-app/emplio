// Runs Emplio's own instructions (../emplio.ts) for a made-up firm (./firm.ts) over every case and marks which door
// the client work went through: a task, a process started, a schedule, a client or its details, a process written,
// or nothing (a question). `bun run eval evals/client-work` in backend; see ../README.md.
import { MODEL_SETS } from "@emplio/shared";
import { Eval } from "braintrust";
import { appendFileSync } from "node:fs";
import type { Said } from "../emplio";
import type { Case } from "./cases";
import { marks, scorers, type Input } from "./scorers";

// Every command gets the firm's answer (or a believable one), with the server's own notes at 4 commands and its stop
// at 8, as in the app (src/chat.ts). It ends when Emplio asks the person, hands off, or ends its reply.
async function work({ business, chat }: Input, name: string): Promise<Said> {
  const { reply, pretend, counted, memory } = await import("../emplio");
  const remember = memory();
  const WORLD = await (await import("./firm")).world();
  const firm = await import("./firm");
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
  // EVAL_DUMP=<file>: each try's case, commands, words and marks, one JSON line each (report.ts reads them)
  if (process.env.EVAL_DUMP) {
    const c = (await (await import("./cases")).cases()).find((x) => x.name === name)!;
    appendFileSync(process.env.EVAL_DUMP, `${JSON.stringify({ name, category: c.category, marks: await marks({ input: { business, chat }, output: said, expected: c.expect }), commands: said.commands, text: said.text })}\n`);
  }
  return said;
}

Eval<Input, Said, Case["expect"]>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "client-work",
  data: async () =>
    (await (await import("./cases")).cases()).map((c) => ({ input: { business: c.business, chat: c.chat }, expected: c.expect, metadata: { name: c.name, category: c.category, source: c.source }, tags: [c.category] })),
  task: (input, { metadata }) => work(input, (metadata as { name: string }).name),
  scores: scorers,
  trialCount: Number(process.env.EVAL_TRIALS) || 3,
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY) || 24,
  metadata: { behaviour: "client-work", model: process.env.EVAL_MODEL || MODEL_SETS.save.chatModel },
});

// Runs Emplio's own instructions (../emplio.ts) over every case and marks whether it handed the work off.
// `bun run eval evals/hand-off` in backend; see ../README.md.
import { MODEL_SETS } from "@emplio/shared";
import { Eval } from "braintrust";
import { appendFileSync } from "node:fs";
import type { Case } from "./cases";
import { scorers, type Input, type Output } from "./scorers";

// The app's files are loaded when first needed, not at the top: some of them wait on things as they load, and the
// runner can't load a file that does (it fails with "Cannot access ... before initialization").
const app = () => import("../emplio");

// Emplio may look a few things up first, as in the app: each command gets a believable result (pretend), the
// reminder comes at 4 commands done by hand, and the commands stop at 8, exactly as the server does it (src/chat.ts).
// It ends when Emplio hands off, asks the person, or just answers.
async function decide({ business, chat, world }: Input): Promise<Output> {
  const { reply, pretend, counted } = await app();
  const { longRunNote, notCounted, refusal, remindAt, skillNote } = await import("../../src/chat");
  let byHand = 0;
  const count = counted();
  const said = await reply(
    business,
    chat,
    (command, step) => {
      if (/\bemplio (hand|ask)\b/.test(command)) return null;
      const nth = count(step, !notCounted(command));
      byHand = Math.max(byHand, nth);
      const refused = refusal(command, nth);
      if (refused) return refused;
      const result = [pretend(command, world), skillNote(nth, command)].filter(Boolean).join("\n\n");
      return nth && remindAt(nth) ? `${result}\n\n${longRunNote(nth, false)}` : result;
    },
    12,
  );
  // EVAL_DUMP=<file>: each try's answer, one JSON line each
  if (process.env.EVAL_DUMP) appendFileSync(process.env.EVAL_DUMP, `${JSON.stringify({ ask: JSON.stringify(chat.at(-1)?.content).slice(0, 200), text: said.text, commands: said.commands })}\n`);
  return { ...said, byHand };
}

Eval<Input, Output, Case["expect"]>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "hand-off",
  data: async () =>
    (await import("./cases")).cases().map((c) => ({ input: { business: c.business ?? {}, chat: c.chat, world: c.world ?? [] }, expected: c.expect, metadata: { name: c.name, category: c.category, source: c.source }, tags: [c.category] })),
  task: decide,
  scores: scorers,
  trialCount: 3,
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY) || 24,
  metadata: { behaviour: "hand-off", model: process.env.EVAL_MODEL || MODEL_SETS.save.chatModel },
});

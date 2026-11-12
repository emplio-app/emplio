// Runs Emplio's own instructions (../emplio.ts) over every case: does it manage (hand the doing to the right agent's
// job, pass the person's words on, check reports) or do the work itself. `bun run eval evals/manager` in backend.
import { MODEL_SETS } from "@emplio/shared";
import { Eval } from "braintrust";
import type { Case } from "./cases";
import { scorers, staysEmplio, type Input, type Output } from "./scorers";

// loaded when first needed, not at the top: see ../README.md
const app = () => import("../emplio");

// Each command gets a believable result (pretend), with the server's own reminders and refusals (src/chat.ts); the
// run ends when Emplio hands off or answers.
async function decide({ business, chat, world, carriesOn }: Input): Promise<Output> {
  const { reply, pretend } = await app();
  const { longRunNote, notCounted, refusal, remindAt, skillNote } = await import("../../src/chat");
  let byHand = 0;
  const said = await reply(
    business,
    chat,
    (command) => {
      if (/\bemplio hand\b/.test(command)) return null;
      const nth = notCounted(command) ? 0 : ++byHand;
      const refused = refusal(command, nth);
      if (refused) return refused;
      const result = [pretend(command, world), skillNote(nth, command)].filter(Boolean).join("\n\n");
      return nth && remindAt(nth) ? `${result}\n\n${longRunNote(nth, false)}` : result;
    },
    12,
  );
  return { ...said, byHand };
}

Eval<Input, Output, Case["expect"]>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "manager",
  data: async () => {
    const { THREADS_HEADING } = await import("../../src/jobs");
    const carriesOn = THREADS_HEADING.includes("--new");
    return (await import("./cases")).cases().map((c) => ({
      input: { business: c.business ?? {}, chat: c.chat, world: c.world ?? [], carriesOn },
      expected: c.expect,
      metadata: { name: c.name, category: c.category, source: c.source },
      tags: [c.category],
    }));
  },
  task: decide,
  scores: [...scorers, staysEmplio],
  trialCount: 3,
  maxConcurrency: 6,
  metadata: { behaviour: "manager", model: process.env.EVAL_MODEL || MODEL_SETS.save.chatModel },
});

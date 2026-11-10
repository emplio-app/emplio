// Runs Emplio's own instructions (../emplio.ts) over every case and marks how it used skills: read the one that
// fits, saved one when the job called for it. `bun run eval evals/skills` in backend; see ../README.md.
import { MODEL_SETS } from "@emplio/shared";
import { Eval } from "braintrust";
import type { Said } from "../emplio";
import type { Case } from "./cases";
import { readOf, savedOf, scorers, type Input } from "./scorers";

const SKILL = (name: string) => `---\nname: ${name}\ndescription: How we do this job\n---\n1. Run /work/company/skills/${name}/run.py with the details.\n2. Check the result, then send it.`;

Eval<Input, Said, Case["expect"]>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "skills",
  // the app's files are loaded when first needed, not at the top (hand-off/hand-off.eval.ts says why)
  data: async () => (await import("./cases")).cases().map((c) => ({ input: { chat: c.chat, world: c.world ?? [] }, expected: c.expect, metadata: { name: c.name, category: c.category, source: c.source, save: c.expect.save !== undefined }, tags: [c.category] })),
  task: async ({ chat, world }, { metadata }) => {
    const { reply, pretend } = await import("../emplio");
    const { SKILLS } = await import("./cases");
    // "use" cases end at the first piece of real work: by then it has read the skill or it hasn't. "save" cases
    // go on (on pretend results) until a skill is written or the reply ends.
    return reply(
      { skills: SKILLS },
      chat,
      (command) => {
        const read = readOf([command])[0];
        if (savedOf([command]).length) return null;
        if (read) return SKILL(read);
        if (/^\s*emplio plan\b/.test(command) || (metadata as { save: boolean }).save) return pretend(command, world);
        return null;
      },
      14,
    );
  },
  scores: scorers,
  trialCount: 3,
  maxConcurrency: 6,
  metadata: { behaviour: "skills", model: process.env.EVAL_MODEL || MODEL_SETS.save.chatModel },
});

// Runs Emplio's own instructions (../emplio.ts) for a made-up agency (./firm.ts) over every case and marks where each
// fact went: a meeting, contact, project, service or client record through its command, notes where they belong,
// and the reply the owner reads. `bun run eval evals/client-records` in backend; see ../README.md.
import { MODEL_SETS } from "@emplio/shared";
import { Eval } from "braintrust";
import { appendFileSync } from "node:fs";
import type { Said } from "../emplio";
import type { Case } from "./cases";
import { reasons, scorers, type Input } from "./scorers";

// a meeting added gets its slug and notes path as the server gives them (src/meetings.ts)
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
function meetingAdded(command: string) {
  const m = /emplio meetings add\s+(?:"([^"]+)"|'([^']+)'|(\S+))(.*)$/.exec(command.split("\n")[0]!);
  if (!m) return null;
  const title = m[1] ?? m[2] ?? m[3]!;
  const date = /--date\s+['"]?(\d{4}-\d{2}-\d{2})/.exec(m[4]!)?.[1] ?? "2026-11-10";
  const s = `${date}-${slug(title)}`;
  return `added ${s}\t${date}\t${title}\nnotes: /work/company/meetings/${s}.md (write them there: what was said, decided, and who does what next)`;
}

// Every command gets the agency's answer (or a believable one), with the server's own notes at 4 commands and its
// stop at 8, as in the app (src/chat.ts). It ends when Emplio asks the person, hands off, or ends its reply.
async function work({ business, chat }: Input, name: string): Promise<Said> {
  const { reply, pretend, counted } = await import("../emplio");
  const firm = await import("./firm");
  const WORLD = await firm.world();
  const { longRunNote, notCounted, refusal, remindAt, skillNote } = await import("../../src/chat");
  const count = counted();
  const failed: string[] = [];
  const changes: string[] = [];
  const results: string[] = [];
  let added = 0;
  const said = await reply(
    business,
    chat,
    (command, step) => {
      if (/\bemplio (hand|ask)\b/.test(command)) return null;
      const nth = count(step, !notCounted(command));
      const refused = refusal(command, nth);
      if (refused) return refused;
      let answer = meetingAdded(command) ?? firm.search(command) ?? pretend(command, WORLD);
      // each task added gets its own id, as in the app
      if (/emplio tasks add/.test(command)) answer = `added ${(0xf00d0000 + ++added).toString(16)}\ttodo`;
      const record = /emplio (clients|contacts|projects|services|meetings|tasks) (add|update|archive|restore|done)\s+(.*)/.exec(command.split("\n")[0]!);
      // a contact added in this reply shows, as in the app
      const added_ = /contacts show\s+['"]?([^'"\n]+)/.exec(command)?.[1]?.trim();
      const was = added_ && changes.find((c) => c.includes("contacts add") && c.toLowerCase().includes(added_.toLowerCase()));
      if (was && /^error:/.test(answer)) answer = `${added_} · updatedAt just now\nnotes: company/contacts/${added_.toLowerCase().replace(/\W+/g, "-")}/index.md\nadded just now: ${was.replace(/^.*contacts add /, "")}`;
      if (/^error:/m.test(answer)) failed.push(command);
      // the records remember what changed in this reply, as the app's do: an update says what it set, and a later
      // show or list carries it under recent changes (src/clients.ts show)
      else if (record) {
        if (record[2] === "update" && answer === "updated") answer = `updated ${record[3]!.slice(0, 300)}`;
        changes.push(`- just now Meera (via Emplio): ${record[1]} ${record[2]} ${record[3]!.slice(0, 200)}`);
      } else if (changes.length && /emplio (clients|contacts|projects|services|meetings|tasks) (show|list)/.test(command)) answer = `${answer}\nrecent changes (newer than the lines above):\n${changes.join("\n")}`;
      results.push(answer.slice(0, 2000));
      const result = [answer, skillNote(nth, command)].filter(Boolean).join("\n\n");
      return nth && remindAt(nth) ? `${result}\n\n${longRunNote(nth, false)}` : result;
    },
    14,
  );
  const out = { ...said, failed, results };
  // EVAL_DUMP=<file>: each try's case, commands, words and marks, one JSON line each
  if (process.env.EVAL_DUMP) {
    const c = (await (await import("./cases")).cases()).find((x) => x.name === name)!;
    appendFileSync(process.env.EVAL_DUMP, `${JSON.stringify({ name, category: c.category, ...(await reasons({ input: { business, chat }, output: out, expected: c.expect }).then((r) => ({ marks: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.score])), why: r }))), commands: said.commands, failed, results, text: said.last ?? said.text })}\n`);
  }
  return out;
}

Eval<Input, Said, Case["expect"]>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "client-records",
  data: async () =>
    // EVAL_CASES=name|name: only those cases (rerunning what failed costs less)
    (await (await import("./cases")).cases()).filter((c) => !process.env.EVAL_CASES || process.env.EVAL_CASES.split("|").includes(c.name)).map((c) => ({ input: { business: c.business, chat: c.chat }, expected: c.expect, metadata: { name: c.name, category: c.category, source: c.source }, tags: [c.category] })),
  task: (input, { metadata }) => work(input, (metadata as { name: string }).name),
  scores: scorers,
  trialCount: Number(process.env.EVAL_TRIALS) || 3,
  maxConcurrency: Number(process.env.EVAL_CONCURRENCY) || 24,
  metadata: { behaviour: "client-records", model: process.env.EVAL_MODEL || MODEL_SETS.save.chatModel },
});

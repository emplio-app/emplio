// How Emplio's use of skills is marked, by code, from the commands it chose.
// The rules are in src/sandbox.ts sandboxPrompt ("Skills:"): change one, change the other.
import type { ModelMessage } from "ai";
import type { Said } from "../emplio";
import type { Case } from "./cases";

export type Input = { chat: ModelMessage[]; world: [string, string][] };
type Args = { input: Input; output: Said; expected: Case["expect"] };
type Score = { name: string; score: number | null; metadata?: Record<string, unknown> };

// the skills it read (`emplio skills use <name>`, or the file itself), in order
export const readOf = (commands: string[]) => commands.flatMap((c) => [...c.matchAll(/emplio skills use\s+["']?([\w-]+)|(?:cat|head|less)\s+\S*skills\/([\w-]+)\/SKILL\.md/g)].map((m) => (m[1] ?? m[2])!));
// a SKILL.md written or changed: by its full path, or from inside its folder (`cd .../skills/<name> && cat > SKILL.md`)
export const savedOf = (commands: string[]) =>
  commands.flatMap((c) => (/(>|\btee)\s*\S*SKILL\.md|SKILL\.md'?\s*<</.test(c) ? [/skills\/([\w-]+)/.exec(c)?.[1] ?? "(unnamed)"] : []));

// The main number: it read the skill that fits (and no other) when there was one, and saved one exactly when the job called for it.
export function rightCall({ output, expected }: Args): Score {
  const read = readOf(output.commands);
  const saved = savedOf(output.commands);
  const wrong: string[] = [];
  if (expected.use === null && read.length) wrong.push(`read ${read.join(", ")} for nothing`);
  if (expected.use && read[0] !== expected.use) wrong.push(read.length ? `read ${read[0]}, not ${expected.use}` : `didn't read ${expected.use}`);
  const ruled = !!expected.rule && output.commands.some((c) => /(>|\btee\b|\bsed -i)[^\n]*\bAGENT\.md|\bAGENT\.md[^\n]*<</.test(c));
  if (expected.save === true && !saved.length && !ruled) wrong.push("no skill saved");
  if (expected.save === false && saved.length) wrong.push(`saved ${saved.join(", ")} for a one-off`);
  return { name: "right_call", score: wrong.length ? 0 : 1, metadata: { wrong, read, saved } };
}

// It read the skill before doing any of the work, not after.
export function readsFirst({ output, expected }: Args): Score {
  if (!expected.use) return { name: "reads_first", score: null };
  const work = output.commands.findIndex((c) => !/^\s*emplio (plan|skills use)\b/.test(c));
  const read = output.commands.findIndex((c) => readOf([c]).includes(expected.use!));
  return { name: "reads_first", score: read >= 0 && (work < 0 || read <= work) ? 1 : 0, metadata: { read, work } };
}

export const scorers = [rightCall, readsFirst];

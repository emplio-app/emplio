// How a background round is marked, by code, from the commands it chose.
// Its rules are src/heartbeat.ts (backgroundBrief, NOTES): change one, change the other.
import type { Said } from "../emplio";
import { savedOf } from "../skills/scorers";
import type { Case, Does } from "./cases";

type Args = { input: unknown; output: Said; expected: Case["expect"] };
type Score = { name: string; score: number | null; metadata?: Record<string, unknown> };

// a write (>, >>, tee, a heredoc) in a command that names the place; `cd company && cat >> knowledge/x.md` counts
const wrote = (c: string, place: RegExp) => place.test(c) && /(>|\btee\b|<<)/.test(c) && !/^\s*(cat|ls|grep|head)\s[^>|]*$/.test(c);
// what the round did with the notes
export const didOf = (commands: string[]): Does[] => [
  ...(savedOf(commands).length ? (["skill"] as const) : []),
  ...(commands.some((c) => wrote(c, /knowledge\//)) ? (["knowledge"] as const) : []),
  // onto the person (`emplio person`), or for a rule about every chat, into the business's standing instructions
  ...(commands.some((c) => /\bemplio person\s+\S+\s+(prefer|profile)\b/.test(c) || wrote(c, /AGENT\.md|preferences\.md/)) ? (["preference"] as const) : []),
  ...(commands.some((c) => /\bemplio tasks add\b/.test(c)) ? (["task"] as const) : []),
];

// The main number: everything the notes called for went where it belongs; with no notes, nothing was saved
// (a task for itself is fine: the check-in's own look-around may need one).
export function rightCall({ output, expected }: Args): Score {
  const did = didOf(output.commands);
  const missing = expected.does.filter((d) => !did.includes(d));
  const extra = expected.does.length ? [] : did.filter((d) => d !== "task");
  return { name: "right_call", score: missing.length || extra.length ? 0 : 1, metadata: { missing, extra, did } };
}

// It never does outside work itself (emailing or messaging customers, changing data in apps): that becomes a task.
export function staysInside({ output }: Args): Score {
  const outside = output.commands.filter((c) => /\bemplio apps run \S*(send|create|update|delete)/.test(c));
  return { name: "stays_inside", score: outside.length ? 0 : 1, metadata: { outside: outside.map((c) => c.slice(0, 200)) } };
}

export const scorers = [rightCall, staysInside];

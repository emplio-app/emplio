// How the reader's note is marked, by code. Its rules are src/reader.ts PROMPT: change one, change the other.
import type { Case } from "./cases";

type Args = { input: unknown; output: string; expected: Case["expect"] };
type Score = { name: string; score: number | null; metadata?: Record<string, unknown> };

const KINDS = ["Fact", "Preference", "Way", "Promise", "Couldn't", "Repeated", "Mood"];
const SILENT = "[SILENT]";
const lines = (note: string) => note.split("\n").map((l) => l.trim().replace(/^[-*]\s*/, "").replace(/^URGENT:\s*/, "")).filter(Boolean);
export const kindsOf = (note: string) => lines(note).flatMap((l) => KINDS.filter((k) => l.replace(/’/g, "'").startsWith(`${k}:`)));

// The main number: silent when there's nothing, and otherwise a line of each kind the chat held.
export function rightCall({ output, expected }: Args): Score {
  const silent = output.trim() === SILENT;
  if (expected.silent || silent) return { name: "right_call", score: expected.silent === silent ? 1 : 0, metadata: { wanted: expected.silent ? "silent" : "a note", got: silent ? "silent" : output.slice(0, 300) } };
  const got = kindsOf(output);
  const missing = (expected.kinds ?? []).filter((anyOf) => !anyOf.some((k) => got.includes(k))).map((anyOf) => anyOf.join(" or "));
  return { name: "right_call", score: missing.length ? 0 : 1, metadata: { missing, got } };
}

// The note keeps its shape: at most 8 lines, each starting with its kind.
export function keepsShape({ output }: Args): Score {
  if (output.trim() === SILENT) return { name: "keeps_shape", score: null };
  const all = lines(output);
  const loose = all.filter((l) => !kindsOf(l).length);
  return { name: "keeps_shape", score: all.length <= 8 && !loose.length ? 1 : 0, metadata: { lines: all.length, loose } };
}

export const scorers = [rightCall, keepsShape];

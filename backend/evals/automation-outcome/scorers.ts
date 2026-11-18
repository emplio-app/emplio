// How the end of an automation's run is marked, all by code, read the way the app reads it (src/automations.ts outcome).
import type { Said } from "../emplio";
import type { Case } from "./cases";

type Outcome = { status: "done" | "failed"; error: string | null; said: string | null };
export type Output = Said & { outcome: Outcome };
type Args = { output: Output; expected: Case["expect"] };
type Score = { name: string; score: number | null; metadata?: Record<string, unknown> };

// Handed work off and ended without waiting: in the app the run waits for that report, and the reply it wakes decides.
const last = (commands: string[], re: RegExp) => commands.map((c) => re.test(c)).lastIndexOf(true);
const lastHand = (commands: string[]) => last(commands, /\bemplio hand\b/) > last(commands, /\bemplio threads wait\b/);
// The main number: the run shows failed exactly when its work didn't get done.
export function rightCall({ output, expected }: Args): Score {
  if (lastHand(output.commands)) return { name: "right_call", score: null, metadata: { handedOff: true, text: output.text.slice(-400) } };
  const failed = output.outcome.status === "failed";
  return { name: "right_call", score: failed === expected.notDone ? 1 : 0, metadata: { wanted: expected.notDone ? "failed" : "done", got: output.outcome.status, text: output.text.slice(-400) } };
}

// A failed run says why, in more than a word: that line is all the person sees of it.
export function saysWhy({ output, expected }: Args): Score {
  if (!expected.notDone || output.outcome.status !== "failed") return { name: "says_why", score: null };
  return { name: "says_why", score: (output.outcome.error ?? "").split(/\s+/).length >= 4 ? 1 : 0, metadata: { why: output.outcome.error } };
}

export const scorers = [rightCall, saysWhy];

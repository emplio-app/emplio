// How a hand-off choice is marked, all by code: the commands Emplio chose say what it decided.
// Each check here has its rule in src/jobs.ts MANAGER_PROMPT: change one, change the other.
import type { ModelMessage } from "ai";
import type { Business, Said } from "../emplio";
import type { Case, Pick } from "./cases";

export type Input = { business: Business; chat: ModelMessage[]; world: [string, string][] };
// byHand: the commands Emplio ran itself before it handed off (or in all)
export type Output = Said & { byHand: number };
type Args = { input: Input; output: Output; expected: Case["expect"] };
type Score = { name: string; score: number | null; metadata?: Record<string, unknown> };

// Where each `emplio hand` in the commands goes.
export function picksOf(commands: string[], b: Business): Pick[] {
  const agents = (b.agents ?? []).map((line) => ({ name: /^- (.+?) \(agents\/([^,]+),/.exec(line)?.[1] ?? "", slug: /\(agents\/([^,]+),/.exec(line)?.[1] ?? "" }));
  const threads = (b.threads ?? []).map((line) => /^- (\w+)/.exec(line)?.[1] ?? "");
  return commands.flatMap((command) =>
    [...command.matchAll(/\bemplio hand\s+(?:"([^"]+)"|'([^']+)'|(\S+))([^\n]*)/g)].map((m): Pick => {
      const pick = (m[1] ?? m[2] ?? m[3])!;
      const thread = threads.find((t) => t && t.startsWith(pick));
      if (thread) return `thread:${thread}`;
      const agent = agents.find((a) => a.name.toLowerCase() === pick.toLowerCase() || a.slug === pick.toLowerCase());
      if (agent) return `agent:${agent.name}`;
      return pick === "myself" ? "myself" : "new";
    }),
  );
}

// The main number: handed off exactly when it should have been. Looking a few things up first is fine.
export function rightCall({ input, output, expected }: Args): Score {
  const handed = picksOf(output.commands, input.business).length > 0;
  const scripted = !!expected.script && output.commands.some((c) => />\s*\S+\.(py|js|ts|sh)\b[^\n]*<</.test(c));
  return { name: "right_call", score: handed === expected.hand || scripted ? 1 : 0, metadata: { wanted: expected.hand ? "hand off" : "itself", got: handed ? "hand off" : "itself", byHand: output.byHand } };
}

// Where it should go, when the case says: its first hand-off is one of the right picks.
export function rightPick({ input, output, expected }: Args): Score {
  const picks = picksOf(output.commands, input.business);
  if (!expected.picks || !picks.length) return { name: "right_pick", score: null };
  return { name: "right_pick", score: expected.picks.includes(picks[0]!) ? 1 : 0, metadata: { wanted: expected.picks, got: picks } };
}

// To the person there is only Emplio: no word of threads, agents or handing off in what it writes to them.
const INSIDE = /\b(threads?|sub-?agents?|agents?|hand(ed|ing|s)? (it |this |that )?(off|over)|background (run|job)s?|workers?|jobs?)\b/i;
export function staysEmplio({ output }: Args): Score {
  if (!output.text.trim()) return { name: "stays_emplio", score: null };
  const said = INSIDE.exec(output.text)?.[0];
  return { name: "stays_emplio", score: said ? 0 : 1, metadata: { said, text: output.text.slice(0, 300) } };
}

// Long work it handed off: was that within the first 4 commands, before the server had to remind it?
export function handsEarly({ input, output, expected }: Args): Score {
  if (!expected.hand || !picksOf(output.commands, input.business).length) return { name: "hands_early", score: null };
  return { name: "hands_early", score: output.byHand <= 4 ? 1 : 0, metadata: { byHand: output.byHand } };
}

export const scorers = [rightCall, rightPick, handsEarly, staysEmplio];

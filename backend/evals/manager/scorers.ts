// How a manager's choice is marked, all by code: the commands Emplio chose say what it decided.
// Each check has its rule in src/jobs.ts (MANAGER_PROMPT, the hand-off): change one, change the other.
import type { ModelMessage } from "ai";
import type { Business, Said } from "../emplio";
import type { Case } from "./cases";
export { staysEmplio } from "../hand-off/scorers";

// carriesOn: the app's `emplio hand <agent>` carries on that agent's job in this chat (the new hand-off); false:
// it always starts a new one and only a thread id carries on (the old one)
export type Input = { business: Business; chat: ModelMessage[]; world: [string, string][]; carriesOn: boolean; name?: string; category?: string; expect?: Case["expect"] };
export type Output = Said & { byHand: number };
type Args = { input: Input; output: Output; expected: Case["expect"] };
type Score = { name: string; score: number | null; metadata?: Record<string, unknown> };

// Where a hand-off went: an agent's name, "new" (an agent made on the spot) or "myself" (a plain copy), and whether it
// carried on that agent's job on the list or started a fresh one. brief: the whole command, briefs included.
export type Route = { agent: string; cont: boolean; brief: string };
export function routesOf(commands: string[], input: Pick<Input, "business" | "carriesOn">): Route[] {
  const agents = (input.business.agents ?? []).map((line) => ({ name: /^- (.+?) \(agents\//.exec(line)?.[1] ?? "", slug: /\(agents\/([^,)]+)/.exec(line)?.[1] ?? "" }));
  const threads = (input.business.threads ?? []).map((line) => ({ id: /^- (\w+)/.exec(line)?.[1] ?? "", agent: line.split(" · ")[1] ?? "" }));
  return commands.flatMap((command) =>
    [...command.matchAll(/\bemplio hand\s+(?:"([^"]+)"|'([^']+)'|(\S+))([^\n]*)/g)].map((m): Route => {
      const pick = (m[1] ?? m[2] ?? m[3])!.trim();
      const flags = m[4] ?? "";
      const thread = /^[0-9a-f]{4,}$/i.test(pick) ? threads.find((t) => t.id.startsWith(pick.toLowerCase())) : undefined;
      if (thread) return { agent: thread.agent, cont: true, brief: command };
      const agent = agents.find((a) => a.name.toLowerCase() === pick.toLowerCase() || a.slug === pick.toLowerCase());
      if (agent) return { agent: agent.name, cont: input.carriesOn && !/--new\b/.test(flags) && threads.some((t) => t.agent === agent.name), brief: command };
      return { agent: pick.toLowerCase() === "myself" ? "myself" : "new", cont: false, brief: command };
    }),
  );
}

// The main number: handed off when it should, to the right agent, carrying on or starting fresh as it should, and
// never to a plain copy of itself.
export function rightCall({ input, output, expected }: Args): Score {
  const r = routesOf(output.commands, input)[0];
  const got = r ? `${r.agent}${r.cont ? " (carry on)" : " (fresh)"}` : "itself";
  const wanted = expected.hand ? `${expected.agent?.join(" or ") ?? "an agent"}${expected.cont === undefined ? "" : expected.cont ? " (carry on)" : " (fresh)"}` : "itself";
  const ok = !expected.hand
    ? !r
    : !!r && r.agent !== "myself" && (!expected.agent || expected.agent.includes(r.agent)) && (expected.cont === undefined || r.cont === expected.cont);
  return { name: "right_call", score: ok ? 1 : 0, metadata: { wanted, got, byHand: output.byHand } };
}

// The person's own words reach the job: every word the case names is in the brief.
export function keepsWords({ input, output, expected }: Args): Score {
  const r = routesOf(output.commands, input)[0];
  if (!expected.say?.length || !r) return { name: "keeps_words", score: null };
  const missing = expected.say.filter((w) => !new RegExp(w, "i").test(r.brief));
  return { name: "keeps_words", score: missing.length ? 0 : 1, metadata: { missing, brief: r.brief.slice(0, 600) } };
}

// Emplio never drives a browser itself, before or instead of handing off.
export function noBrowser({ output }: Args): Score {
  const used = output.commands.find((c) => /\bemplio browser\b/.test(c) && !/\bemplio hand\b/.test(c));
  return { name: "no_browser", score: used ? 0 : 1, metadata: used ? { used: used.slice(0, 200) } : undefined };
}

// Work handed off: with at most 2 commands of its own first (looking things up), not after doing a share itself.
export function handsEarly({ input, output, expected }: Args): Score {
  if (!expected.hand || !routesOf(output.commands, input).length) return { name: "hands_early", score: null };
  return { name: "hands_early", score: output.byHand <= 2 ? 1 : 0, metadata: { byHand: output.byHand } };
}

export const scorers = [rightCall, keepsWords, noBrowser, handsEarly];

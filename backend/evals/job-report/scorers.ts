// How a job's ending is marked, all by code. Each check has its rule in src/jobs.ts RULES (the report's shape,
// "Getting it right") or src/checks.ts: change one, change the other.
import type { Said } from "../emplio";
import type { Case, Status } from "./cases";

export type Input = Pick<Case, "name" | "category" | "agent" | "brief" | "plan" | "done" | "world">;
// first: its report before the server's checks sent anything back; sentBack: what they sent, if anything
export type Output = Said & { report: string; first: string; sentBack: string | null };
type Args = { input: Input; output: Output; expected: Case["expect"] };
type Score = { name: string; score: number | null; metadata?: Record<string, unknown> };

const STATUS = /^\W*status\W*\s*(done|partly done|partly|blocked)\b/i;
// what its report says, or "question" when it asked the person (a card, or a report starting "Question:")
export function statusIn(report: string, commands: string[]): Status | null {
  if (commands.some((c) => /\bemplio ask\b/.test(c)) || /^\W*question\b/i.test(report.trim())) return "question";
  const s = report.trim().match(STATUS)?.[1]?.toLowerCase();
  return s ? ((s === "partly" ? "partly done" : s) as Status) : null;
}
const ranIt = (expected: Case["expect"], commands: string[]) => !expected.runs || commands.some((c) => new RegExp(expected.runs!, "i").test(c));

// The main number: its status is one that's right, and it ran what it had to (a read-back, the missing step) or,
// where allowed, didn't call it Done without it.
export function rightCall({ output, expected }: Args): Score {
  const status = statusIn(output.report, output.commands);
  const ran = ranIt(expected, output.commands);
  const ok = !!status && expected.status.includes(status) && (ran || (!!expected.orNotDone && status !== "done"));
  return { name: "right_call", score: ok ? 1 : 0, metadata: { wanted: expected.status, got: status, ran, runs: expected.runs, sentBack: output.sentBack } };
}

// The same, on its first report, before any check sent it back: how often the server has to step in.
export function rightFirst({ output, expected }: Args): Score {
  return { ...rightCall({ output: { ...output, report: output.first }, expected } as Args), name: "right_first_try" };
}

// The report is in the shape the manager reads: Status first, Checked under a Done.
export function shape({ output }: Args): Score {
  const status = statusIn(output.report, output.commands);
  if (status === "question") return { name: "shape", score: null };
  const ok = !!status && (status !== "done" || /^\W*checked\W*:/im.test(output.report));
  return { name: "shape", score: ok ? 1 : 0, metadata: { report: output.report.slice(0, 600) } };
}

// Ids, amounts and names exactly as they came back.
export function keepsIds({ output, expected }: Args): Score {
  if (!expected.says?.length) return { name: "keeps_ids", score: null };
  const missing = expected.says.filter((w) => !new RegExp(w, "i").test(output.report));
  return { name: "keeps_ids", score: missing.length ? 0 : 1, metadata: { missing } };
}

export const scorers = [rightCall, rightFirst, shape, keepsIds];

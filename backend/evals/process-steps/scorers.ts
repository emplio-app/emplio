// How work inside a process is marked, all by code: which runs and tasks the commands moved, and how.
// Each check has its rule in src/sandbox.ts (processes), src/processes.ts (its help) and src/tasks.ts (taskMessage):
// change one, change the other.
import type { ModelMessage } from "ai";
import type { Business, Said } from "../emplio";
import { key, writesOf } from "../client-work/scorers";
import type { Act, Case } from "./cases";

export type Input = { business: Business; chat: ModelMessage[] };
type Args = { input?: Input; output: Said; expected: Case["expect"] };
type Score = { name: string; score: number | null; metadata?: Record<string, unknown> };

// What each command did: the act, the run or task it named, what it set.
export function actsOf(commands: string[]): { act: Act; id: string; flags: Record<string, string> }[] {
  const hands = commands.filter((c) => /\bemplio hand\b/.test(c)).map(() => ({ act: "hand" as const, id: "", flags: {} }));
  return [...hands, ...writesOf(commands).flatMap((w) => {
    const [first, ...rest] = w.command.trim().split(/\s+/).slice(w.command.trim().split(/\s+/).indexOf("emplio") + 1);
    const sub = rest[0];
    const id = w.args[0] ?? "";
    if (first === "processes" && (sub === "set" || sub === "back" || sub === "stop")) return [{ act: sub as Act, id, flags: Object.fromEntries(Object.entries(w.flags).map(([k, v]) => [key(k), v])) }];
    if (first === "processes" && sub === "start") return [{ act: "process" as const, id, flags: Object.fromEntries(Object.entries(w.flags).map(([k, v]) => [key(k), v])) }];
    if (first === "tasks" && sub === "done") return [{ act: "done" as const, id, flags: w.flags }];
    if (first === "tasks" && sub === "update" && (w.flags.status === "done" || w.flags.status === "waiting")) return [{ act: w.flags.status as Act, id, flags: w.flags }];
    // a note or a date on a task, its status left alone, changes no work
    if (first === "tasks" && sub === "update" && (!w.flags.status || w.flags.status === "doing") && !w.flags.to) return [];
    if (first === "tasks") return [{ act: "task" as const, id, flags: w.flags }];
    if (first === "clients") return [{ act: "client" as const, id, flags: w.flags }];
    if (first === "ask") return [{ act: "ask" as const, id, flags: w.flags }];
    return [];
  })];
}
const loose = (v: string) => (/^[\d,._\s]+$/.test(v.trim()) ? String(Number(v.replace(/[,_\s]/g, ""))) : v.trim().toLowerCase());

// The main number: each act it should do, on the right run or task, and no other write.
export function rightCall({ output, expected }: Args): Score {
  const did = actsOf(output.commands);
  // an act may be one of several (done, or waiting on a person); handing it off counts where the case allows it,
  // as the agent finishes it and Emplio updates the task from its report (src/tasks.ts taskMessage)
  const handed = (expected.allow ?? []).includes("hand") && did.some((d) => d.act === "hand");
  const missing = expected.acts.filter((e) => !handed && !did.some((d) => (d.act === e.act || e.or?.includes(d.act)) && (!e.id || d.id.startsWith(e.id) || e.id.startsWith(d.id))));
  const fine = new Set<Act>([...expected.acts.flatMap((e) => [e.act, ...(e.or ?? [])]), ...(expected.allow ?? []), "hand"]);
  const extra = did.filter((d) => !fine.has(d.act) && !(d.act === "ask" && !expected.acts.length));
  return { name: "right_call", score: missing.length || extra.length ? 0 : 1, metadata: { wanted: expected.acts, did: did.map((d) => `${d.act} ${d.id}`), missing, extra: extra.map((d) => `${d.act} ${d.id}`) } };
}

// What it set or started with is what was said (55,000 is 55000), and nothing made up.
export function rightValues({ output, expected }: Args): Score {
  const want = expected.acts.filter((e) => e.inputs);
  if (!want.length) return { name: "right_values", score: null };
  const did = actsOf(output.commands);
  const wrong: string[] = [];
  for (const e of want) {
    const d = did.find((x) => x.act === e.act && (!e.id || x.id.startsWith(e.id)));
    if (!d) continue;
    for (const [k, v] of Object.entries(e.inputs!)) if (!d.flags[k] || loose(d.flags[k]!) !== loose(v)) wrong.push(`${k}: ${d.flags[k] ?? "(none)"}`);
  }
  if (!did.some((d) => want.some((e) => e.act === d.act))) return { name: "right_values", score: null };
  return { name: "right_values", score: wrong.length ? 0 : 1, metadata: { wanted: want.map((e) => e.inputs), wrong } };
}

// A step sent back says what to fix, so whoever redoes it knows.
export function saysWhy({ output }: Args): Score {
  const back = actsOf(output.commands).filter((d) => d.act === "back");
  if (!back.length) return { name: "says_why", score: null };
  return { name: "says_why", score: back.every((d) => (d.flags.note ?? "").trim().length >= 10) ? 1 : 0, metadata: { notes: back.map((d) => d.flags.note ?? "(none)") } };
}

export const scorers = [rightCall, rightValues, saysWhy];
export const marks = async (a: Args) => Object.fromEntries(scorers.map((s) => { const r = s(a); return [r.name, r.score]; }));

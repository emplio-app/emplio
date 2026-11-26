// How client work is marked, all by code: the commands Emplio ran say which door the work went through.
// Each check has its rule in src/sandbox.ts (Clients, processes) and the commands' own help (src/clients.ts,
// src/processes.ts, src/automations.ts, src/tasks.ts): change one, change the other.
import type { ModelMessage } from "ai";
import type { Business, Said } from "../emplio";
import type { Case, Kind } from "./cases";

export type Input = { business: Business; chat: ModelMessage[] };
type Args = { input?: Input; output: Said; expected: Case["expect"] };
type Score = { name: string; score: number | null; metadata?: Record<string, unknown> };

// A command line in words, as a shell reads it: quotes kept together, a heredoc's text apart.
export function words(command: string): { words: string[]; body: string } {
  const [first, ...rest] = command.split("\n");
  const heredoc = /<<-?\s*['"]?(\w+)['"]?/.exec(first!);
  const body = heredoc ? rest.slice(0, rest.lastIndexOf(heredoc[1]!) < 0 ? undefined : rest.lastIndexOf(heredoc[1]!)).join("\n") : "";
  const line = heredoc ? first!.slice(0, heredoc.index) : command;
  const out: string[] = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3])!);
  return { words: out, body };
}

// One write a command made: its door, and what it said.
export type Write = { kind: Kind; flags: Record<string, string>; args: string[]; body: string; command: string };
export function writesOf(commands: string[]): Write[] {
  return commands.flatMap((command) =>
    command.split(/\n?\s*(?:;|&&)\s*(?=emplio\b)/).flatMap((part): Write[] => {
      const { words: w, body } = words(part.trim());
      const i = w.indexOf("emplio");
      // a file written straight into the company's processes or automations folder is the same as adding it
      const file = /company\/(processes|automations|contacts)\/([\w-]+)(?:\/index)?\.md/.exec(part);
      const fileKind = (): Kind => (file![1] === "processes" ? "write-process" : file![1] === "contacts" ? "contact" : automationKind(body));
      if (i < 0) return file && /<</.test(part) && /(^|&&|;)\s*(cat|tee)\b/.test(part) ? [{ kind: fileKind(), flags: {}, args: [file[2]!], body, command: part }] : [];
      const [area, sub, ...rest] = w.slice(i + 1);
      const flags: Record<string, string> = {};
      const args: string[] = [];
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k]!;
        if (a.startsWith("--")) flags[a.slice(2)] = rest[k + 1] && !rest[k + 1]!.startsWith("--") ? rest[++k]! : "";
        else if (a !== "-") args.push(a);
      }
      const write = (kind: Kind): Write[] => [{ kind, flags, args, body, command: part }];
      if (area === "tasks" && sub === "add") return write(flags.every !== undefined ? "repeat" : "task");
      if (area === "tasks" && (sub === "update" || sub === "done" || sub === "remove")) return write("change");
      if (area === "automations" && (sub === "add" || sub === "update")) return write(automationKind(body));
      if (area === "processes" && sub === "start") return write("process");
      if (area === "processes" && (sub === "add" || sub === "update")) return write("write-process");
      if (area === "processes" && (sub === "set" || sub === "back" || sub === "stop")) return write("change");
      if (area === "clients" && sub === "add") return write("client");
      if (area === "clients" && sub === "update") {
        // "Detail=value" words are details; --stage, --handler, --name change the client
        // Stage=active is --stage active, as the app reads it (src/clients.ts)
        const own = (a: string) => ["stage", "handler", "name"].includes(a.slice(0, a.indexOf("=")).trim().toLowerCase());
        const details = args.slice(1).some((a) => a.includes("=") && !own(a));
        const changes = ["stage", "handler", "name"].some((f) => f in flags) || args.some((a) => a.includes("=") && own(a));
        return [...(details ? write("detail") : []), ...(changes || !details ? write("client") : [])];
      }
      if (area === "ask") return write("ask");
      return [];
    }),
  );
}
// an input's flag as the app reads it: --Invoice, '--Due date' and --due-date are one (src/processes.ts inputKey)
export const key = (k: string) => k.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const automationKind = (body: string): Kind => (/^when:\s*new client\s*$/m.test(body) ? "new-client" : "repeat");

// A name matches a client when it's its name or slug, loosely (northwind, Northwind Traders, northwind-traders).
const same = (a: string, b: string) => {
  const s = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return s(a).includes(s(b)) || s(b).includes(s(a));
};
// 85,000 is 85000; 2026-11-01 and "1 Nov 2026" are the same day
const loose = (v: string) => {
  const t = v.trim().toLowerCase();
  if (/^[\d,._\s]+$/.test(t)) return String(Number(t.replace(/[,_\s]/g, "")));
  const d = /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : Number.isNaN(Date.parse(t)) ? null : new Date(Date.parse(t) + 12 * 3600_000).toISOString().slice(0, 10);
  return d ?? t.replace(/^fy\s*/, "");
};
// a question to the person, on a card or in words
const asked = (output: Said) => writesOf(output.commands).some((w) => w.kind === "ask") || /\?\s*$/m.test(output.last ?? output.text);

// The main number: the work went through each door it should, and through no other that writes.
export function rightCall({ output, expected }: Args): Score {
  const done = writesOf(output.commands).map((w) => w.kind);
  const fine = new Set<Kind>([...expected.kinds, ...(expected.allow ?? [])]);
  const missing = expected.kinds.filter((k) => (k === "ask" ? !asked(output) : !done.includes(k)));
    // a question after the work (a card) writes nothing
  const extra = [...new Set(done.filter((k) => !fine.has(k) && k !== "ask"))];
  return { name: "right_call", score: missing.length || extra.length ? 0 : 1, metadata: { wanted: expected.kinds, did: done, missing, extra } };
}

// Tasks and process runs it made are for the right client.
export function rightClient({ input, output, expected }: Args): Score {
  if (!expected.client) return { name: "right_client", score: null };
  const made = writesOf(output.commands).filter((w) => w.kind === "task" || w.kind === "process");
  if (!made.length) return { name: "right_client", score: null };
  // no --client: the app labels a task whose title names one client with it (src/tasks.ts)
  const named = (w: Write) => w.kind === "task" && new RegExp(`\\b${expected.client}\\b`, "i").test(w.args.join(" "));
  const bad = made.filter((w) => (w.flags.client ? !same(w.flags.client, expected.client!) : !named(w)));
  return { name: "right_client", score: bad.length ? 0 : 1, metadata: { wanted: expected.client, got: made.map((w) => w.flags.client ?? `(title) ${w.args.join(" ")}`), inChat: !!input?.business.client } };
}

// The task or the repeat goes to the right person.
const TEAM: Record<string, string[]> = { meera: ["meera", "me"], raj: ["raj"], priya: ["priya"] };
export function rightPerson({ output, expected }: Args): Score {
  if (!expected.to) return { name: "right_person", score: null };
  const made = writesOf(output.commands).filter((w) => w.kind === "task" || (w.kind === "repeat" && !w.body));
  if (!made.length) return { name: "right_person", score: null };
  const ok = (to: string | undefined) => !!to && TEAM[expected.to!]!.some((n) => to.toLowerCase() === n || to.toLowerCase().startsWith(`${n}@`) || to.toLowerCase().split(/\s+/)[0] === n);
  const bad = made.filter((w) => !ok(w.flags.to));
  return { name: "right_person", score: bad.length ? 0 : 1, metadata: { wanted: expected.to, got: made.map((w) => w.flags.to ?? "(none)") } };
}

// The process started is the right one, with what was said filled in, and nothing made up.
export function rightInputs({ output, expected }: Args): Score {
  const start = writesOf(output.commands).find((w) => w.kind === "process");
  if (!expected.process || !start) return { name: "right_inputs", score: null };
  const wrong: string[] = [];
  if (start.args[0] !== expected.process) wrong.push(`process ${start.args[0]}`);
  const flags = Object.fromEntries(Object.entries(start.flags).map(([k, v]) => [key(k), v]));
  for (const [k, v] of Object.entries(expected.inputs ?? {})) if (!flags[k] || loose(flags[k]!) !== loose(v)) wrong.push(`${k}: ${flags[k] ?? "(none)"}`);
  const extra = Object.keys(flags).filter((k) => !["client", "for", "period", ...Object.keys(expected.inputs ?? {})].includes(k));
  return { name: "right_inputs", score: wrong.length || extra.length ? 0 : 1, metadata: { wanted: expected.inputs ?? {}, got: start.flags, wrong, extra } };
}

// Every process or automation it wrote is one the app can read, and the automation runs when and for whom it should.
// A repeating task (tasks add --every) is read as the automation it becomes.
export async function rightFile({ output, expected }: Args): Promise<Score> {
  // the app's own readers, loaded when first needed (../hand-off/hand-off.eval.ts says why)
  const { parseAutomation } = await import("../../src/automations");
  const { parseProcess } = await import("../../src/processes");
  const writes = writesOf(output.commands);
  // the last of each file: a file the app refused (the stand-in gives its error back) is fixed and saved again
  const files = [...new Map(writes.filter((w) => w.body && (w.kind === "write-process" || w.kind === "repeat" || w.kind === "new-client")).map((w) => [`${w.kind === "write-process"}:${w.args[0]}`, w])).values()];
  const repeats = writes.filter((w) => w.kind === "repeat" && !w.body);
  if (!files.length && !repeats.length) return { name: "right_file", score: null };
  const wrong: string[] = [];
  const process = files.find((w) => w.kind === "write-process");
  for (const w of files) {
    if (w.kind === "write-process") {
      const p = parseProcess(w.body);
      if ("error" in p) wrong.push(`process ${w.args[0]}: ${p.error}`);
      continue;
    }
    const a = parseAutomation(w.body);
    if ("error" in a) {
      wrong.push(`automation ${w.args[0]}: ${a.error}`);
      continue;
    }
    const f = expected.file ?? {};
    if (f.when && a.when !== f.when) wrong.push(`when: ${a.when}`);
    const proc = f.process ?? (process && expected.kinds.includes("write-process") ? process.args[0] : undefined);
    if (proc && a.process !== proc) wrong.push(`process: ${a.process}`);
    if (f.clients && !(a.clients ?? []).some((c) => c.toLowerCase().includes(f.clients!) || (f.clients === "*" && c.toLowerCase() === "all"))) wrong.push(`clients: ${JSON.stringify(a.clients)}`);
    // starting a process: who and when are in its steps, not here
    if (f.who && !a.process && !(a.who ?? a.agent ?? "").toLowerCase().includes(f.who)) wrong.push(`who: ${a.who}`);
    if (f.due !== undefined && !a.process && a.dueDays !== f.due) wrong.push(`due: ${a.dueDays}`);
  }
  for (const w of repeats) {
    const f = expected.file ?? {};
    if (f.process) wrong.push("a repeating task can't start a process: it needs an automation with process:");
    if (f.clients && !(w.flags.clients ?? "").toLowerCase().includes(f.clients === "*" ? "all" : f.clients)) wrong.push(`--clients ${w.flags.clients}`);
    if (f.who && !(w.flags.to ?? w.flags.agent ?? "").toLowerCase().includes(f.who)) wrong.push(`--to ${w.flags.to}`);
    if (f.due !== undefined && Number(w.flags["due-days"]) !== f.due) wrong.push(`--due-days ${w.flags["due-days"]}`);
  }
  return { name: "right_file", score: wrong.length ? 0 : 1, metadata: { wrong, files: files.map((w) => w.body.slice(0, 400)), repeats: repeats.map((w) => w.command.slice(0, 300)) } };
}

export const scorers = [rightCall, rightClient, rightPerson, rightInputs, rightFile];
export const marks = async (a: Args) => Object.fromEntries(await Promise.all(scorers.map(async (s) => { const r = await s(a); return [r.name, r.score] as const; })));

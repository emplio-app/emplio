// How the records work is marked: by code, off the commands Emplio ran (which record, through which command, with
// what), and one judge for the reply the owner reads. Each check has its rule in src/sandbox.ts ("What you keep",
// "Where things go") and the commands' own help (src/meetings.ts, contacts.ts, projects.ts, services.ts, clients.ts):
// change one, change the other.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, type ModelMessage } from "ai";
import type { Business, Said } from "../emplio";
import { periodOf } from "../../src/records";
import { words } from "../client-work/scorers";
import type { Case, Kind } from "./cases";

export type Input = { business: Business; chat: ModelMessage[] };
type Args = { input?: Input; output: Said; expected: Case["expect"] };
type Score = { name: string; score: number | null; metadata?: Record<string, unknown> };

// One write a command made: its door, its flags, its words, and the file it wrote (a note).
export type Write = { kind: Kind; flags: Record<string, string>; args: string[]; path?: string; command: string };
const RECORDS: Record<string, [Kind, Kind]> = {
  meetings: ["meeting", "meeting-change"],
  contacts: ["contact", "contact-change"],
  projects: ["project", "project-change"],
  services: ["service", "service-change"],
  clients: ["client", "client-change"],
};

// a file written under the business's folders: which kind of note it is
const noteKind = (path: string): Kind | null => {
  const m = /(?:company|restricted|shared)\/(meetings|clients|contacts|projects|services|team|knowledge)\//.exec(path);
  if (!m) return null;
  return m[1] === "meetings" ? "meeting-notes" : m[1] === "knowledge" ? "knowledge" : "notes";
};
const WRITES = /(^|[;&|]\s*)(cat|tee)\b[^\n]*(>|<<)|^\s*(cat\s*>>?|tee)\s|\bsed\s+-i\b|>>?\s*\S*\.md/;

export function writesOf(commands: string[]): Write[] {
  return commands.flatMap((command) =>
    command.split(/\n?\s*(?:;|&&)\s*(?=emplio\b)/).flatMap((part): Write[] => {
      const { words: w } = words(part.trim());
      const i = w.indexOf("emplio");
      if (i < 0) {
        // 2>/dev/null and 2>&1 hide errors, they write nothing
        const line = part.split("\n")[0]!.replace(/\s\d>(&\d|\s*\/dev\/null)/g, "");
        const path = /(\/work\/)?((?:company|restricted|shared)\/[\w./-]+\.md)/.exec(line)?.[2];
        const kind = path && WRITES.test(line) ? noteKind(path) : null;
        return kind ? [{ kind, flags: {}, args: [], path, command: part }] : [];
      }
      const [area, sub, ...rest] = w.slice(i + 1);
      const flags: Record<string, string> = {};
      const args: string[] = [];
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k]!;
        if (a.startsWith("--")) flags[a.slice(2)] = rest[k + 1] && !rest[k + 1]!.startsWith("--") ? rest[++k]! : "";
        else if (a !== "-") args.push(a);
      }
      const write = (kind: Kind): Write[] => [{ kind, flags, args, command: part }];
      const pair = RECORDS[area ?? ""];
      if (pair && sub === "add") return write(pair[0]);
      if (pair && sub === "update") return /^(yes|true|on)$/i.test(flags.private ?? "") ? write("private") : write(pair[1]);
      if (pair && ["archive", "restore", "remove", "delete"].includes(sub ?? "")) return write(pair[1]);
      if (area === "tasks" && sub === "add") return write("task");
      if (area === "tasks" && ["update", "done", "remove"].includes(sub ?? "")) return write("task-change");
      if (area === "processes" && ["start", "set", "back", "stop"].includes(sub ?? "")) return write("process");
      if (area === "ask") return write("ask");
      return [];
    }),
  );
}

// a question to the person, on a card or in words
const asked = (output: Said) => writesOf(output.commands).some((w) => w.kind === "ask") || /\?\s*$/m.test(output.last ?? output.text);

// The main number: every record it should touch, through its command, and no other write.
// what the app refused did nothing (a duplicate contact, a field that isn't one): Said.failed, from the eval
const tried = (output: Said) => writesOf(output.commands.filter((c) => !(output as Said & { failed?: string[] }).failed?.includes(c)));
export function rightCall({ output, expected }: Args): Score {
  const done = tried(output).map((w) => w.kind);
  const fine = new Set<Kind>([...expected.kinds, ...(expected.allow ?? [])]);
  // a meeting just added may have its people or title put right
  if (fine.has("meeting")) fine.add("meeting-change");
  const missing = expected.kinds.filter((k) => (k === "ask" ? !asked(output) : !done.includes(k)));
  const extra = [...new Set(done.filter((k) => !fine.has(k) && k !== "ask"))];
  return { name: "right_call", score: missing.length || extra.length ? 0 : 1, metadata: { wanted: expected.kinds, did: done, missing, extra } };
}

// 3.5L is 350000, "45k" 45000, "₹60,000" 60000
export const amount = (v: string) => {
  const m = /([\d.,]+)\s*(k|l|lakh|lac|cr)?\b/i.exec(v.replace(/₹|rs\.?|inr/gi, ""));
  if (!m) return v.trim().toLowerCase();
  const n = Number(m[1]!.replace(/,/g, "")) * ({ k: 1e3, l: 1e5, lakh: 1e5, lac: 1e5, cr: 1e7 }[(m[2] ?? "").toLowerCase()] ?? 1);
  return String(Math.round(n));
};
const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9@.]+/g, " ").trim();

// What each record carried: the client, project, people, lead, email, price it was told.
export function rightDetails({ output, expected }: Args): Score {
  if (!expected.has) return { name: "right_details", score: null };
  const writes = tried(output);
  const wrong: string[] = [];
  for (const [kind, want] of Object.entries(expected.has) as [Kind, Record<string, string | string[]>][]) {
    const mine = writes.filter((w) => w.kind === kind);
    if (!mine.length) continue; // right_call marks it missing
    const ok = (w: Write) =>
      Object.entries(want).every(([flag, v]) => {
        const got = flag === "name" ? w.args.join(" ") : (w.flags[flag] ?? "");
        if (Array.isArray(v)) return v.every((x) => flat(got).includes(x));
        if (flag === "amount") return amount(got) === amount(v);
        if (flag === "period") return periodOf(got) === v;
        return flat(got).includes(flat(v));
      });
    if (!mine.some(ok)) wrong.push(`${kind}: wanted ${JSON.stringify(want)}, got ${mine.map((w) => w.command.split("\n")[0]).join(" | ")}`);
  }
  return { name: "right_details", score: wrong.length ? 0 : 1, metadata: { wrong } };
}

// A meeting's notes go where its add said: meetings/<its slug>.md, not a made-up name.
export function notesWhereSaid({ output }: Args): Score {
  const notes = writesOf(output.commands).filter((w) => w.kind === "meeting-notes");
  if (!notes.length) return { name: "notes_where_said", score: null };
  const slugs = output.commands.filter((c) => /emplio meetings (add|show|list|update)/.test(c));
  const bad = notes.filter((w) => !/meetings\/\d{4}-\d{2}-\d{2}-[\w-]+\.md$/.test(w.path!) && !slugs.length);
  return { name: "notes_where_said", score: bad.length ? 0 : 1, metadata: { paths: notes.map((w) => w.path) } };
}

const JUDGE_MODEL = "anthropic/claude-sonnet-5.5";
const JUDGE = [
  "You check the last message an AI employee sent the owner of a client-servicing firm (an agency, a law or accounting firm), after the owner told it something or asked it something.",
  "The owner is Meera, who is chatting (\"I\", \"me\" and \"you\" are her). Her team: Raj (member) and Priya (admin); owners and admins see private records. Connected apps: Gmail, Google Sheets, Zoho Books, WhatsApp Business. Today is Tuesday 10 November 2026.",
  "You see the chat, the commands it ran with what each answered (the business's records and the app's replies), and its last message. Answer PASS only if all of these hold:",
  "1. It answers or confirms what the owner said: for a question, the answer itself (names, amounts, dates as the records give them); for an update, what it saved, in a few plain words.",
  "2. It claims nothing it didn't do or find: no 'I've emailed' without a send, no figures the records didn't give.",
  "3. It reads like a sharp colleague, not software: short, no command names, file paths, ids or slugs, no technical words.",
  "4. It doesn't ask for what the owner already said, or ask permission for something it should simply have done. A short closing offer of a useful next step is fine.",
  "Otherwise answer FAIL. Reply with PASS or FAIL, then one short sentence saying why.",
].join("\n");

// The reply the owner reads: right, honest, short, in their words.
export async function goodReply({ input, output }: Args): Promise<Score> {
  if (!input) return { name: "good_reply", score: null };
  const said = (output.last ?? output.text).trim();
  // ended on a hand-off or a question card: the reply comes later in the app (the eval stops there)
  if (!said && /\bemplio (hand|ask)\b/.test(output.commands.at(-1) ?? "")) return { name: "good_reply", score: null };
  if (!said) return { name: "good_reply", score: 0, metadata: { why: "no message at all" } };
  const results = (output as Said & { results?: string[] }).results ?? [];
  const chat = input.chat.filter((m) => typeof m.content === "string").map((m) => `${m.role === "user" ? "Owner" : "AI employee"}: ${m.content as string}`).join("\n\n");
  const { text } = await generateText({
    model: createOpenRouter()(JUDGE_MODEL),
    system: JUDGE,
    prompt: `The chat:\n\n${chat}\n\nWhat it ran, and what each answered:\n${output.commands.map((c, i) => `$ ${c.slice(0, 1500)}\n${(results[i] ?? "").slice(0, 2000)}`).join("\n") || "(nothing)"}\n\nIts last message:\n${said}`,
    maxOutputTokens: 1000,
  });
  if (!text.trim()) throw new Error("the judge said nothing");
  return { name: "good_reply", score: /^\W*PASS/i.test(text) ? 1 : 0, metadata: { why: text.trim() } };
}

export const scorers = [rightCall, rightDetails, notesWhereSaid, goodReply];
export const marks = async (a: Args) => Object.fromEntries(await Promise.all(scorers.map(async (s) => { const r = await s(a); return [r.name, r.score] as const; })));
// the same, with each mark's reason (the judge's words), for the dump
export const reasons = async (a: Args) => Object.fromEntries(await Promise.all(scorers.map(async (s) => { const r = await s(a); return [r.name, { score: r.score, why: r.metadata?.why ?? r.metadata?.wrong ?? r.metadata?.missing }] as const; })));

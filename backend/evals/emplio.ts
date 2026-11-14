// Emplio as the evals run it: the app's own instructions (src/chat.ts emplioPrompt, agentRules; src/sandbox.ts;
// src/jobs.ts) for a made-up business, the same bash tool, and the models of the Save money quality (Haiku): what works on the cheapest holds on the dearer ones. Commands aren't
// run: each gets a stand-in result, and the eval looks at which commands Emplio chose.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { MODEL_SETS } from "@emplio/shared";
import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRules, BASH_DESCRIPTION, bashInput, contextNote, emplioPrompt, mainChatNote, PYTHON_DESCRIPTION, pythonInput } from "../src/chat";
import { HEARTBEAT } from "../src/heartbeat";
import { AGENTS_HEADING, THREADS_HEADING } from "../src/jobs";
import { inPython, sandboxPrompt, type Session } from "../src/sandbox";
import { DEFAULTS } from "../src/settings";

// A made-up business: a furnishings shop in Pune. Nothing here is a real customer's.
const ctx = { workspaceName: "Kaveri Home Furnishings", userName: "Meera", role: "owner" as const };
const session = { conversationId: "c", workspaceId: "w", workspaceName: ctx.workspaceName, user: { id: "u", name: ctx.userName, email: "meera@kaveri.example" }, role: "owner", attachments: [], settings: DEFAULTS, watched: true, channel: "web" } as Session;

export type Business = {
  // "- company/skills/<name>: <when to use it>", as the app lists them
  skills?: string[];
  // "- <Name> (agents/<slug>, light): <what it does>"
  agents?: string[];
  // "- <id> · <agent or myself> · <name> · <status>, <when>"
  threads?: string[];
};

export const CHAT_MODEL = process.env.EVAL_MODEL || MODEL_SETS.save.chatModel;
// Code mode by default (EVAL_CODE_MODE=0 for bash): the same cases in code mode (src/sandbox.ts codeMode): the python tool and its instructions, the
// Python really running, with every emplio command, shell command and business file answered by the same stand-ins
export const CODE_MODE = process.env.EVAL_CODE_MODE !== "0";
process.env.CODE_MODE = CODE_MODE ? "1" : "0";
export const BACKGROUND_MODEL = process.env.EVAL_MODEL || MODEL_SETS.save.backgroundModel;

// round: a background round (the owner's check-in), which nobody watches, on the cheaper model
export const system = (b: Business, round: boolean) => [
  emplioPrompt({
    rules: agentRules(ctx, round ? HEARTBEAT : undefined),
    computer: sandboxPrompt(round ? { ...session, automation: true, thinker: true, watched: false } : session),
    team: ["- Meera <meera@kaveri.example>, owner", "- Raj <raj@kaveri.example>, member", "- Priya <priya@kaveri.example>, admin"],
    connected: "- Gmail (meera@kaveri.example)\n- Google Sheets\n- Zoho Books\n- WhatsApp Business",
    business: "We sell curtains, cushions and bed linen from one shop in Pune and online. GST is 12% on linen, 18% on cushions. Quotes are valid 15 days.",
    userName: ctx.userName,
    personal: "Runs the shop. Prefers short answers. Hindi or English.",
    skills: b.skills?.length ? b.skills : ["(none yet)"],
  }),
  "This chat's id is ab12cd34.",
  ...(round ? [] : [mainChatNote(ctx)]),
];

// The note the app puts on the person's message: today's date, the agents and the threads to carry on.
const note = (b: Business) =>
  contextNote(
    {
      channel: "They're in the web app.",
      date: "Today is Tuesday, 10 November 2026 (Asia/Kolkata time).",
      chats: "",
      agents: [AGENTS_HEADING, ...(b.agents?.length ? b.agents : ["(none yet)"])].join("\n"),
      threads: b.threads?.length ? [THREADS_HEADING, ...b.threads].join("\n") : "",
    },
    [],
  )!.text;

// messages: the reply as the chat keeps it (its commands and their results), for chats that go on (workday)
// usage: what the reply took, all its steps (cost: what OpenRouter charged, in dollars)
export type Said = { text: string; commands: string[]; messages?: ModelMessage[]; usage?: { input: number; output: number; cost: number } };

// One command Emplio already ran in this reply, for chats that start mid-work.
let calls = 0;
export const ran = (description: string, command: string, output: string): ModelMessage[] => {
  const toolCallId = `call_${++calls}`;
  // code mode: the same step as the python tool would have run it, so the chat so far shows the tool it has
  if (CODE_MODE) {
    const [first, ...rest] = command.split("\n");
    const call = /^emplio [a-z]/.test(first!) ? inPython(`\`${first}\``).slice(1, -1) : "";
    const body = rest.slice(0, -1).join("\n");
    const code = call.startsWith("emplio.") ? `print(${call.replace('input="""..."""', `input=${JSON.stringify(body)}`)})` : `print(sh(${JSON.stringify(command)}))`;
    return [
      { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName: "python", input: { description, code } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId, toolName: "python", output: { type: "json", value: { exitCode: 0, output: inPython(output) } } }] },
    ];
  }
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName: "bash", input: { description, command } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId, toolName: "bash", output: { type: "json", value: { exitCode: 0, output } } }] },
  ];
};
export const person = (text: string): ModelMessage => ({ role: "user", content: text });
export const emplio = (text: string): ModelMessage => ({ role: "assistant", content: text });

// What stand-in a command gets, or null to stop there: the choice the eval is about has been made.
// step: which tool call it's part of. In code mode one step (a run of Python) can make many commands; a step counts
// once toward how many Emplio did by hand, as the server counts it (counted, below).
export type StandIn = (command: string, step: number) => string | null;
// The by-hand count after this command: one more for the first counted command of a step, as the server counts steps.
export const counted = () => {
  let n = 0;
  let last = -1;
  return (step: number, counts: boolean) => (counts && step !== last ? ((last = step), ++n) : counts ? n : 0);
};
let steps_ = 0;

// A believable result for the everyday commands, so Emplio can look around before it decides. Nothing is run.
// A chain (`a; echo ---; b`) answers part by part, as a shell would; a write prints nothing.
// ponytail: a few dozen commands by pattern, not a shell; a case whose job needs more gives its own results (world)
const FILES: [RegExp, string][] = [
  [/heartbeat\.md/, "# Check-ins\n\n## Always check\n- New emails that need a reply from us\n- Customer or staff messages nobody has answered"],
  [/journal\.md/, "# Background agent's journal\n\n## Open matters\n(nothing open)\n\n## Tried\n(nothing yet)"],
  [/goals\.md/, "# Goals\n\n## Grow online orders to 40% of sales by March\n## Collect every invoice within 30 days"],
  [/AGENT\.md/, "We sell curtains, cushions and bed linen from one shop in Pune and online."],
  [/(profile|preferences)\.md/, "Runs the shop. Prefers short answers. Hindi or English."],
  // the script two cases talk about (skills, background-round): it has to be there for a skill to be made of it
  [
    /slip\/make\.py/,
    `#!/usr/bin/env python3
# usage: make.py <order number>
# reads the order from Zoho Books and writes /work/out/packing-slip-<number>.pdf
import json, subprocess, sys
from fpdf import FPDF

number = sys.argv[1]
order = json.loads(subprocess.check_output(["emplio", "apps", "run", "zoho_books.get_order", json.dumps({"number": number})]))
pdf = FPDF()
pdf.add_page()
pdf.set_font("Helvetica", size=14)
pdf.cell(0, 10, f"Packing slip: order {number}", new_x="LMARGIN", new_y="NEXT")
pdf.cell(0, 8, order["customer"], new_x="LMARGIN", new_y="NEXT")
pdf.multi_cell(0, 8, order["address"])
for item in order["items"]:
    pdf.cell(0, 8, f'{item["qty"]} x {item["name"]}', new_x="LMARGIN", new_y="NEXT")
pdf.output(f"/work/out/packing-slip-{number}.pdf")
print(f"Saved /work/out/packing-slip-{number}.pdf")`,
  ],
];
const one = (c: string): string => {
  if (/<<|(^|[^2&])>\s*\S/.test(c) || /^\s*(cd|mkdir|cp|mv|touch|chmod|export|set)\b/.test(c)) return "";
  const echo = /^\s*echo\s+(.*)$/s.exec(c);
  if (echo) return echo[1]!.replace(/^["']|["']$/g, "");
  if (/\bemplio plan\b/.test(c)) return "Checklist saved.";
  if (/\bemplio (search|history search)\b/.test(c)) return "No matches.";
  if (/\bemplio history show\b/.test(c)) return "(nothing in it beyond what you already have)";
  if (/\bemplio apps list\b/.test(c)) return "gmail (connected)\ngooglesheets (connected)\nzoho_books (connected)\nwhatsapp (connected)";
  if (/\bemplio apps actions\b/.test(c))
    return "zoho_books.list_invoices  List invoices (by date, status, customer)\nzoho_books.list_items  List items with stock and price\nzoho_books.get_order  One order by number\ngmail.search  Search mail\ngmail.send_email  Send an email\ngooglesheets.get_values  Read a sheet\ngooglesheets.append_row  Add a row\ngooglesheets.update_values  Change cells in a range\ngooglesheets.delete_rows  Delete rows by number";
  if (/\bemplio apps info\b/.test(c)) return 'input: {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "status": "unpaid|paid|all", "q": "search words"}';
  if (/\bemplio apps run \S*get_order/.test(c)) return '{"number":"4410","customer":"Anita Desai","items":[{"name":"Bedsheet king ivory","qty":2}],"address":"12 Baner Rd, Pune"}';
  if (/\bemplio apps run\b/.test(c)) return "[]";
  // the web answers, but never in one go: results to open, pages to read, as it is for real
  if (/\bemplio web (search|similar)\b/.test(c)) return "10 results. The first 3:\n1. A directory page listing many sellers, each with its own page (https://www.indiamart.example/list)\n2. A buyer's guide comparing a few options, prices not shown (https://www.guide.example/compare)\n3. A seller's own site: prices on request (https://www.seller.example)\nOpen a page with `emplio web read <url>` for its details.";
  if (/\bemplio web answer\b/.test(c)) return "Sources disagree and most give no current figures; the details are on each one's own page. Read the pages for exact numbers.";
  if (/\bemplio web read\b/.test(c)) return "(about 2,100 words) A long page: names and descriptions, a contact form, and some figures in a table further down. No single summary of what you're after.";
  if (/\bemplio browser skill\b/.test(c)) return "open <url>, snapshot, find <words>, click <ref>, fill <ref> <text>, requests. Read a page with snapshot before acting on it.";
  if (/\bemplio browser\b/.test(c)) return "Page opened: 48 links, 12 buttons. Snapshot saved to /work/tmp/browser/page.txt";
  if (/tmp\/browser\/page\.txt/.test(c)) return "[1] link Home  [2] link Shop  [3] textbox Search  [4] link Offers  [5] link Account  … 43 more links, 12 buttons; the page's own content starts below the menu";
  if (/\bemplio tasks add\b/.test(c)) return "Task added.";
  if (/\bemplio tasks\b/.test(c)) return "(no tasks)";
  if (/\bemplio person\b/.test(c)) return "Saved.";
  if (/\bemplio (activity|notes)\b/.test(c)) return "(nothing since the last round)";
  if (/\bemplio db tables\b/.test(c)) return "(no tables yet)";
  if (/\bemplio\b/.test(c)) return "ok";
  // a file a job made: there, and what its report said is in it
  if (/^\s*(cat|head|tail|sed|wc|less)\b.*\/work\/out\//.test(c)) return "(the job's file: what its report says it holds)";
  if (/^\s*(cat|head|tail|sed|wc|less)\b/.test(c)) return FILES.find(([file]) => file.test(c))?.[1] ?? `cat: ${c.trim().split(/\s+/).at(-1)}: No such file or directory`;
  if (/^\s*ls\b/.test(c) && /tmp\/slip/.test(c)) return "make.py";
  if (/^\s*ls\b/.test(c)) return /company\/?(\s|$)/.test(c) ? "AGENT.md  README.md  goals.md  heartbeat.md  agents  automations  inbox  knowledge  skills  tools" : "";
  if (/^\s*(grep|find)\b/.test(c)) return "";
  return "";
};
// world: what this business's commands answer, first match wins: [words in the command (a regular expression), the result]
export type World = [string, string][];
export const pretend = (command: string, world: World = []): string =>
  // a heredoc is one write, whatever is in it; a chain answers part by part, each from the world first
  (/<</.test(command) ? [command] : command.split(/\s*(?:;|&&|\n)\s*/))
    .map((part) => world.find(([words]) => new RegExp(words).test(part))?.[1] ?? one(part.split(/\s*\|\s*/)[0]!.replace(/\s+2>(&1|\/dev\/null)/g, "")))
    .filter(Boolean)
    .join("\n") || "(no output)";

// Emplio's reply to a chat whose last message is the person's (the note goes on it, as in the app).
// session: a Python session to keep across replies (code mode; a conversation's), else one for this reply only
export async function reply(b: Business, chat: ModelMessage[], standIn: StandIn, maxSteps = 4, round = false, session?: string): Promise<Said> {
  const last = chat.map((m) => m.role).lastIndexOf("user");
  const asked = chat[last]!;
  const messages = [...chat.slice(0, last), { ...asked, content: `${asked.content as string}\n\n${note(b)}` } as ModelMessage, ...chat.slice(last + 1)];
  const commands: string[] = [];
  let stop = false;
  const bash = tool({
    description: BASH_DESCRIPTION,
    inputSchema: bashInput,
    execute: async ({ command }) => {
      commands.push(command);
      const out = standIn(command, ++steps_);
      if (out === null) stop = true;
      return { exitCode: 0, output: out ?? "(stopped here)" };
    },
  });
  const python = tool({
    description: PYTHON_DESCRIPTION,
    inputSchema: pythonInput,
    execute: async ({ code, restart }) => {
      // the server's notes ([...] after a result) go under the run's own output, as the app adds them, once each
      const notes = new Set<string>();
      const step = ++steps_;
      let first = true;
      const answer = (command: string) => {
        commands.push(command);
        const out = standIn(command, step);
        first = false;
        if (out === null) {
          stop = true;
          return "(stopped here)";
        }
        const [result, ...extra] = out.split(/\n\n(?=\[)/);
        for (const n of extra) notes.add(n);
        return result!;
      };
      const ran = await runPython(session ?? key, code, !!restart, answer);
      // a run that called nothing still counts as a step done by hand
      if (first && !stop) {
        const out = standIn(`python3 <<'EOF'\n${code}\nEOF`, step);
        if (out === null) stop = true;
        for (const n of (out ?? "").split(/\n\n(?=\[)/).slice(1)) notes.add(n);
      }
      return { exitCode: ran.exitCode, output: [ran.output, ...[...notes].map(inPython)].join("\n\n") };
    },
  });
  const key = crypto.randomUUID();
  const began = Date.now();
  const { steps, response } = await generateText({
    model: createOpenRouter()(round ? BACKGROUND_MODEL : CHAT_MODEL),
    providerOptions: { openrouter: { cacheControl: { type: "ephemeral" }, reasoning: DEFAULTS.reasoning === "off" ? { enabled: false } : { effort: DEFAULTS.reasoning as "low" | "medium" | "high" } } },
    system: system(b, round).map((content, i) => ({ role: "system" as const, content: CODE_MODE ? inPython(content) : content, ...(i === 0 && { providerOptions: { openrouter: { cacheControl: { type: "ephemeral" } } } }) })),
    messages,
    tools: CODE_MODE ? { python } : { bash },
    stopWhen: [stepCountIs(maxSteps), () => stop],
  });
  if (CODE_MODE && !session) endPython(key);
  const usage = {
    input: steps.reduce((n, s) => n + (s.usage.inputTokens ?? 0), 0),
    output: steps.reduce((n, s) => n + (s.usage.outputTokens ?? 0), 0),
    cost: steps.reduce((n, s) => n + Number((s.usage.raw as { cost?: number } | undefined)?.cost ?? 0), 0),
  };
  // EVAL_USAGE=<file>: every reply's cost, tokens and steps, one JSON line each, to add up a run (both modes)
  if (process.env.EVAL_USAGE) appendFileSync(process.env.EVAL_USAGE, `${JSON.stringify({ ...usage, steps: steps.length, commands: commands.length, ms: Date.now() - began })}\n`);
  return { text: steps.map((s) => s.text).filter(Boolean).join("\n"), commands, messages: response.messages, usage };
}

// ---- code mode: the real Python session on a stand-in computer (code/fake.py) ----
const KERNEL = join(import.meta.dir, "../src/python/kernel.py");
const FAKE = join(import.meta.dir, "code/fake.py");
type Answer = (command: string) => string;
const answering = new Map<string, Answer>();
const folders = new Map<string, string>();
let server: ReturnType<typeof Bun.serve> | undefined;

// what a shell would have run for each request, so the markers read both modes the same way
const word = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : w.includes("'") ? JSON.stringify(w) : `'${w}'`);
const heredoc = (text: string) => ` <<'EOF'\n${text.replace(/\n$/, "")}\nEOF`;
type Ask = { args?: string[]; stdin?: string | null; sh?: string; read?: string; ls?: string; write?: string; text?: string };
// What the library gets back, as the server answers code (src/sandbox.ts liveRoutes): rows, results and lists as
// data, everything else in the words code writes
function asData(a: Ask, out: string) {
  const [area, sub] = a.args!;
  if (/^\s*[[{]/.test(out)) return out;
  if (area === "db" && sub === "sql") return out === "ok" ? (/^\s*(select|with)\b/i.test(a.args![2] === "-" ? (a.stdin ?? "") : (a.args![2] ?? "")) ? "[]" : '{"changed": 1, "last_id": 1}') : out;
  if (area === "db" && sub === "tables" && /no tables/.test(out)) return "[]";
  if (area === "tasks" && (sub === "list" || sub === "search") && /no tasks/i.test(out)) return "[]";
  if (area === "web" && (sub === "search" || sub === "similar"))
    return JSON.stringify([...out.matchAll(/^\d+\. (.+) \((https?:\/\/\S+)\)$/gm)].map((m) => ({ title: m[1], url: m[2], date: null, text: m[1] })));
  return inPython(out);
}
const asCommand = (a: Ask) =>
  a.args ? `emplio ${a.args.map(word).join(" ")}${a.stdin ? heredoc(a.stdin) : ""}`
  : a.sh !== undefined ? `${a.sh}${a.stdin ? heredoc(a.stdin) : ""}`
  : a.read ? `cat ${a.read}`
  : a.ls ? `ls ${a.ls}`
  : `cat > ${a.write}${heredoc(a.text ?? "")}`;

function fakeServer() {
  server ??= Bun.serve({
    port: 0,
    async fetch(req) {
      const key = new URL(req.url).pathname.slice(1);
      const a = (await req.json()) as Ask;
      const answer = answering.get(key);
      const out = answer ? answer(asCommand(a)) : "";
      return Response.json({ out: a.args ? asData(a, out) : out, code: 0 });
    },
  });
  server.unref(); // the stand-in server mustn't keep the eval run open once it's done
  return server;
}

async function runPython(key: string, code: string, restart: boolean, answer: Answer) {
  answering.set(key, answer);
  if (!folders.has(key)) folders.set(key, mkdtempSync(join(tmpdir(), "emplio-eval-")));
  const work = folders.get(key)!;
  const p = Bun.spawn(["python3", KERNEL, "run", key, ...(restart ? ["--restart"] : [])], {
    cwd: work,
    stdin: new TextEncoder().encode(code),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, EMPLIO_WORK: work, EMPLIO_FAKE: `http://127.0.0.1:${fakeServer().port}/${key}`, EMPLIO_FAKE_LIB: FAKE, EZ_KEY: "eval" },
  });
  const timer = setTimeout(() => p.kill(), 120_000);
  const [out, err, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  // the server's /work, as a person's own computer maps it back
  return { exitCode, output: (out + err).replaceAll(work, "/work").trim() || "(no output)" };
}

// a session done with: its process stopped and its folder gone
export function endPython(key: string) {
  answering.delete(key);
  const work = folders.get(key);
  folders.delete(key);
  if (!work) return;
  try {
    const info = JSON.parse(require("node:fs").readFileSync(join(work, "tmp/.emplio/sessions", `${key}.json`), "utf8"));
    process.kill(info.pid);
  } catch {}
  rmSync(work, { recursive: true, force: true });
}

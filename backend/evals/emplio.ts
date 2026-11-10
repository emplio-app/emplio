// Emplio as the evals run it: the app's own instructions (src/chat.ts emplioPrompt, agentRules; src/sandbox.ts;
// src/jobs.ts) for a made-up business, the same bash tool, and the model the Default quality uses. Commands aren't
// run: each gets a stand-in result, and the eval looks at which commands Emplio chose.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { MODEL_SETS } from "@emplio/shared";
import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { agentRules, BASH_DESCRIPTION, bashInput, contextNote, emplioPrompt, mainChatNote } from "../src/chat";
import { HEARTBEAT } from "../src/heartbeat";
import { sandboxPrompt, type Session } from "../src/sandbox";
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

export const CHAT_MODEL = process.env.EVAL_MODEL || MODEL_SETS.default.chatModel;
export const BACKGROUND_MODEL = process.env.EVAL_MODEL || MODEL_SETS.default.backgroundModel;

// round: a background round (the owner's check-in), which nobody watches, on the cheaper model
const system = (b: Business, round: boolean) => [
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
      agents: ["Your agents (`emplio hand <name>`):", ...(b.agents?.length ? b.agents : ["(none yet)"])].join("\n"),
      threads: b.threads?.length ? ["Threads you can carry on with `emplio hand <id>`, latest first:", ...b.threads].join("\n") : "",
    },
    [],
  )!.text;

export type Said = { text: string; commands: string[] };

// One command Emplio already ran in this reply, for chats that start mid-work.
let calls = 0;
export const ran = (description: string, command: string, output: string): ModelMessage[] => {
  const toolCallId = `call_${++calls}`;
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId, toolName: "bash", input: { description, command } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId, toolName: "bash", output: { type: "json", value: { exitCode: 0, output } } }] },
  ];
};
export const person = (text: string): ModelMessage => ({ role: "user", content: text });
export const emplio = (text: string): ModelMessage => ({ role: "assistant", content: text });

// What stand-in a command gets, or null to stop there: the choice the eval is about has been made.
export type StandIn = (command: string) => string | null;

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
  [/slip\/make\.py/, "#!/usr/bin/env python3\n# usage: make.py <order number>\n# reads the order from Zoho Books and writes /work/out/packing-slip-<number>.pdf"],
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
    return "zoho_books.list_invoices  List invoices (by date, status, customer)\nzoho_books.list_items  List items with stock and price\ngmail.search  Search mail\ngmail.send_email  Send an email\ngooglesheets.get_values  Read a sheet\ngooglesheets.append_row  Add a row";
  if (/\bemplio apps info\b/.test(c)) return 'input: {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "status": "unpaid|paid|all", "q": "search words"}';
  if (/\bemplio apps run\b/.test(c)) return "[]";
  if (/\bemplio browser skill\b/.test(c)) return "open <url>, snapshot, find <words>, click <ref>, fill <ref> <text>, requests. Read a page with snapshot before acting on it.";
  if (/\bemplio browser\b/.test(c)) return "Page opened: 48 links, 12 buttons. Snapshot saved to /work/tmp/browser/page.txt";
  if (/\bemplio tasks add\b/.test(c)) return "Task added.";
  if (/\bemplio tasks\b/.test(c)) return "(no tasks)";
  if (/\bemplio person\b/.test(c)) return "Saved.";
  if (/\bemplio (activity|notes)\b/.test(c)) return "(nothing since the last round)";
  if (/\bemplio db tables\b/.test(c)) return "(no tables yet)";
  if (/\bemplio\b/.test(c)) return "ok";
  if (/^\s*(cat|head|tail|sed|wc|less)\b/.test(c)) return FILES.find(([file]) => file.test(c))?.[1] ?? `cat: ${c.trim().split(/\s+/).at(-1)}: No such file or directory`;
  if (/^\s*ls\b/.test(c) && /tmp\/slip/.test(c)) return "make.py";
  if (/^\s*ls\b/.test(c)) return /company\/?(\s|$)/.test(c) ? "AGENT.md  README.md  goals.md  heartbeat.md  agents  automations  inbox  knowledge  skills  tools" : "";
  if (/^\s*(grep|find)\b/.test(c)) return "";
  return "";
};
export const pretend = (command: string): string =>
  // a heredoc is one write, whatever is in it
  (/<</.test(command) ? [command] : command.split(/\s*(?:;|&&|\n)\s*/))
    .map((part) => one(part.split(/\s*\|\s*/)[0]!.replace(/\s+2>(&1|\/dev\/null)/g, "")))
    .filter(Boolean)
    .join("\n") || "(no output)";

// Emplio's reply to a chat whose last message is the person's (the note goes on it, as in the app).
export async function reply(b: Business, chat: ModelMessage[], standIn: StandIn, maxSteps = 4, round = false): Promise<Said> {
  const last = chat.map((m) => m.role).lastIndexOf("user");
  const asked = chat[last]!;
  const messages = [...chat.slice(0, last), { ...asked, content: `${asked.content as string}\n\n${note(b)}` } as ModelMessage, ...chat.slice(last + 1)];
  const commands: string[] = [];
  let stop = false;
  const { steps } = await generateText({
    model: createOpenRouter()(round ? BACKGROUND_MODEL : CHAT_MODEL),
    providerOptions: { openrouter: { cacheControl: { type: "ephemeral" }, reasoning: DEFAULTS.reasoning === "off" ? { enabled: false } : { effort: DEFAULTS.reasoning as "low" | "medium" | "high" } } },
    system: system(b, round).map((content, i) => ({ role: "system" as const, content, ...(i === 0 && { providerOptions: { openrouter: { cacheControl: { type: "ephemeral" } } } }) })),
    messages,
    tools: {
      bash: tool({
        description: BASH_DESCRIPTION,
        inputSchema: bashInput,
        execute: async ({ command }) => {
          commands.push(command);
          const out = standIn(command);
          if (out === null) stop = true;
          return { exitCode: 0, output: out ?? "(stopped here)" };
        },
      }),
    },
    stopWhen: [stepCountIs(maxSteps), () => stop],
  });
  return { text: steps.map((s) => s.text).filter(Boolean).join("\n"), commands };
}

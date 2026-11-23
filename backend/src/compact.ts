// Keeping a chat going past what fits in one request. Past a budget, everything the model is sent so far
// is replaced, for the model only, by notes a cheap model writes about it. Every message is still stored
// and shown, and the agent can search them (`emplio history`). The notes are kept on the conversation
// (summary, summaryUpto), so each stretch of chat is summarised once, and the next fold updates them.
// Checked before every step of a reply, so a long run of commands can't outgrow the window either.
// ponytail: no re-read of the files the chat had open; the notes say to read them again before relying on them
import { modelFor, type Settings } from "@emplio/shared";
import type { Bill } from "./credit";
import { model } from "./models";
import { generateText, type ModelMessage, type SystemModelMessage, type UIMessage } from "ai";
import { inName } from "./files";

// Past settings.compactAt tokens, the chat so far is folded into notes. The model takes far more; this keeps
// replies fast and cheap. COMPACT_AT_TOKENS moves the default (and makes testing a fold cheap).

// Only until the provider has counted a real request: code, JSON and ids run nearer 2-3 characters a token.
const CHARS_PER_TOKEN = 3;
// An attached image or PDF goes along as base64 (or bytes): counted as text, one photo looked like 100k+ tokens
// and every message with a file was summarised. The provider bills it far less.
// ponytail: flat guess per file; a long PDF costs more, but the real count takes over after the first step
const FILE_TOKENS = 2000;
export function estimate(x: unknown) {
  let files = 0;
  const text = typeof x === "string" ? x : JSON.stringify(x, (_, v) => (v instanceof Uint8Array || (typeof v === "string" && v.startsWith("data:")) ? (files++, "") : v));
  return Math.ceil(text.length / CHARS_PER_TOKEN) + files * FILE_TOKENS;
}

// `text` cut to its first `head` and last `tail` characters when it's longer than both and a notice
const ends = (text: string, head: number, tail: number, note = "left out") =>
  text.length <= head + tail + 200 ? text : `${text.slice(0, head)}\n[... ${(text.length - head - tail).toLocaleString()} characters ${note} ...]\n${text.slice(-tail)}`;

// What the note-taker reads at most (~100k tokens, inside a cheap model's window whatever compactAt is set to):
// past it, the start and the end of the transcript, the middle marked as left out.
// The chat's full history stays searchable (emplio history), and the end decides what happens next.
const MAX_TRANSCRIPT = 300_000;

// Older turns, cut down before they're sent: a long
// command output keeps its start and end, an output repeated later becomes one line, and files attached back
// then become a line saying where they are. The last KEEP_TURNS of the person's messages stay as they were.
// The line between moves TRIM_EVERY of their messages at a time, not one per message, so what's sent before
// it stays byte for byte the same and the provider's prompt cache keeps covering it: one cache miss per ten.
const KEEP_TURNS = 3;
const TRIM_EVERY = 10;
type Part = UIMessage["parts"][number];
export function trimOld(ui: UIMessage[]) {
  const asks = ui.flatMap((m, i) => (m.role === "user" ? [i] : []));
  const n = Math.floor(Math.max(0, asks.length - KEEP_TURNS) / TRIM_EVERY) * TRIM_EVERY;
  if (!n) return ui;
  const cut = asks[n]!;
  const later = new Set<string>();
  const trim = (p: Part): Part => {
    if (p.type === "file")
      return { type: "text", text: `[Attached here: "${p.filename ?? "file"}" (${p.mediaType}), no longer shown. It's at /work/in/${inName(p)}; open it again if it matters now.]` };
    const result = p.type.startsWith("tool-") ? ((p as { output?: unknown }).output as { output?: unknown } | undefined) : undefined;
    const out = result?.output;
    if (typeof out !== "string") return p;
    const repeat = out.length >= 200 && later.has(out);
    later.add(out);
    const output = repeat ? "[Same output as a later run, shown there.]" : ends(out, 1500, 1500, "of this older output left out (the chat's history has it whole, or run it again)");
    return output === out ? p : ({ ...p, output: { ...result, output } } as Part);
  };
  // newest first, so a repeat is known when its earlier copy comes up
  const old = ui.slice(0, cut).reverse().map((m) => ({ ...m, parts: [...m.parts].reverse().map(trim).reverse() })).reverse();
  return [...old, ...ui.slice(cut)];
}

// Inside one run (a job's long reply), older command outputs are cut down as it goes, so a long run doesn't fill
// up on outputs it has already read and need folding every few minutes (a job folded 9 times in 40 minutes). The
// last KEEP_OUTPUTS stay whole; older ones keep their start and end. Cut BATCH at a time, so what's sent before the
// line stays the same and the provider's prompt cache keeps covering it. The SDK carries the cut messages on to the
// next step, so each is cut once.
const KEEP_OUTPUTS = 5;
const BATCH = 10;
const CUT_MARK = "older output, read already";
type ToolResult = { type: string; output?: { type?: string; value?: { output?: unknown } } };
export function trimSteps(sending: ModelMessage[]): ModelMessage[] | null {
  const results = sending.flatMap((m, i) =>
    m.role === "tool" ? (m.content as ToolResult[]).flatMap((p, j) => (p.type === "tool-result" ? [{ i, j }] : [])) : [],
  );
  const old = results.slice(0, Math.max(0, results.length - KEEP_OUTPUTS));
  const long = (r: { i: number; j: number }) => {
    const out = ((sending[r.i]!.content as ToolResult[])[r.j]!.output?.value as { output?: unknown } | undefined)?.output;
    return typeof out === "string" && out.length > 1200 && !out.includes(CUT_MARK);
  };
  const due = old.filter(long);
  if (due.length < BATCH) return null;
  const next = [...sending];
  for (const { i, j } of due) {
    const m = next[i]!;
    const content = [...(m.content as ToolResult[])];
    const p = content[j]!;
    const value = p.output!.value as { output: string };
    // a saved long output's note says where the whole of it is: kept
    const where = value.output.match(/The whole output \([^)]*\) is saved in [^\s]+/)?.[0];
    const output = ends(value.output, 400, 400, `of this ${CUT_MARK}${where ? `; ${where}` : "; run it again if you need it"}`);
    content[j] = { ...p, output: { ...p.output, value: { ...value, output } } };
    next[i] = { ...m, content } as ModelMessage;
  }
  return next;
}

// How the context note on a person's message starts (chat.ts contextNote): ours, not their words, and it says
// what's true at that moment; the notes after a fold get a fresh one, so the note-taker leaves them out.
export const CONTEXT_MARK = "[As of this message:";

// The transcript as tagged text rather than a chat: laid out as a chat, a model tends to carry it on.
const content = (c: unknown) => (typeof c === "string" ? [{ type: "text", text: c }] : (c as Record<string, any>[]));
function transcribe(m: ModelMessage) {
  const parts = content(m.content).flatMap((p): string[] => {
    if (p.type === "text") return p.text.startsWith(CONTEXT_MARK) ? [] : [p.text];
    if (p.type === "file" || p.type === "image") return [`[attached file${p.filename ? `: ${p.filename}` : ""}]`];
    if (p.type === "tool-call") return [`<call tool="${p.toolName}">${JSON.stringify(p.input)}</call>`];
    if (p.type === "tool-result") {
      const out = p.output?.value ?? p.output;
      return [`<result tool="${p.toolName}">${ends(typeof out === "string" ? out : JSON.stringify(out), 4000, 1500)}</result>`];
    }
    return []; // reasoning: the model's own working, not something the notes need
  });
  if (m.role === "user") return `<person>\n${parts.join("\n")}\n</person>`;
  if (m.role === "tool") return parts.join("\n");
  return `<assistant>\n${parts.join("\n")}\n</assistant>`;
}

const SYSTEM = `You are a note-taker. You get a finished transcript of a conversation between a person \
at a business and their AI employee, which works on its own Linux computer (bash commands, company files in \
git) and the business's apps (Gmail, Calendar, Zoho, ...).

You never continue that conversation and never answer it. You only write notes about it, in the third \
person, for the AI employee to work from after the original messages are thrown away. Everything not in your \
notes is lost to it.

Write these headings, dropping any with nothing under it. Finished and unfinished work never mix: the AI \
employee does what's under "Still to do" and treats everything else as already handled.
- Still to do: only what the person asked for that hasn't been done yet, the latest first, in their words. An \
instruction that was carried out (an email that went out, a file that was made) is never here; when everything \
asked is done, write "Nothing".
- Preferences: only rules meant for every job from now on (tone, formats, who to copy, what never to do) and \
every correction they made to how the AI employee works. A wording, sentence or point they wanted in one email, \
draft or task is not a preference, even when it reads like one: it goes with that piece of work, under Done once \
it went out, under Still to do while it hasn't.
- Their messages: every message the person sent, in order, in their own words. Not a paraphrase and not a \
selection.
- Facts: everything established that a later turn would otherwise have to look up again.
- Done: what was created, changed, sent or deleted, in order, each with its outcome, the date, and any id, \
path or link it came back with. For each email or message that went out: to whom, when, its id, every point it \
made (quoting its key sentences) and what the person asked to have in it, so a follow-up doesn't say it again.
- Answered: questions the person asked that were already answered, each with its answer.
- Failed: what went wrong, the exact error, and what it turned out to mean or what fixed it.
- Open: anything promised, waiting on someone, or left half-done.
- Right now: what was being done in the last few messages and the next step it was heading for, quoting the \
exact words that asked for it. This decides whether the AI employee carries on or starts over, so it is about \
the end of the transcript, not the whole.

Three rules decide whether these notes are any good:
1. COPY EVERY IDENTIFIER character for character: ids, file paths, commands, URLs, email addresses, phone \
numbers, amounts, dates, names of automations, apps and actions. If unsure whether something is one, it is.
2. NEVER REPLACE A LIST WITH ITS COUNT. "Ten customers" throws the customers away; write all ten.
3. QUOTE ERRORS EXACTLY, then say what fixed them.

If the transcript starts with earlier notes, they are what's left of an even earlier part: keep everything in \
them, update what has changed (what got done moves from Still to do and Open to Done) and add the rest.

Be dense: bullets, short lines, no preamble, no closing line. Never brief at the cost of a detail.`;

// A job's notes: its work (brief, additions, checklist) is on its job card (jobs.ts), shown with them, so they hold
// what it did and found, and stay short: a job's notes once grew past the note-taker's limit.
const JOB_SYSTEM = `You are a note-taker. You get a transcript of an AI agent part-way through one job, working on its \
own computer (Python, files under /work) and in the business's apps. Its brief, everything added to it and its \
checklist are kept elsewhere and shown to it: don't copy them. You never continue the transcript; you only write \
notes it works from after these messages are thrown away. Everything not in your notes is lost to it.

Write these headings, dropping any with nothing under it:
- Done: each finished piece of work, in order, with what came back: files written (full paths), ids, amounts, counts.
- Facts: everything established that it would otherwise look up again: exact values, and how a site, app or file \
works (addresses, endpoints, fields, formats, what returned what).
- Session: the functions and variables in its Python session that hold work, by name, with what each does or holds.
- Failed: what didn't work, the exact error, and what fixed it or what not to try again.
- Right now: what it was doing in the last steps and its very next step, quoting the command or file it was on.

Rules: copy every identifier exactly (ids, paths, URLs, amounts, dates, names). A list of under 20 items: write every \
item; a longer one: say which file holds it. Quote errors exactly. If the transcript starts with earlier notes, keep \
what still matters in them and update the rest. Dense bullets, no preamble. At most about 2,500 words: when it would \
run over, shorten what's oldest and settled in Done and Facts, never Session, Failed or Right now.`;

const TASK = `The transcript above is over. Do not reply to it, continue it, or address the person.
Write the notes: Still to do / Preferences / Their messages / Facts / Done / Answered / Failed / Open / Right now. Copy every \
identifier exactly, list every item of every list, quote every message and every error exactly.`;

// Notes on `messages`, building on `previous`; null when no model managed it (the caller sends the chat as is).
// the compaction model (settings.summaryModel or its Quality's), then this one if it's down. Cheap, big window, thinking off: this is transcription, not reasoning.
const BACKUP_MODEL = "deepseek/deepseek-v4-flash";

export async function summarise(
  messages: ModelMessage[],
  previous: string | null,
  settings: Pick<Settings, "summaryModel" | "modelSet" | "openrouterKey">,
  bill: Bill,
  signal?: AbortSignal,
  job = false,
) {
  const said = messages.map(transcribe).join("\n\n");
  const transcript = [
    previous ? `<earlier-notes>\n${previous}\n</earlier-notes>` : "",
    `<transcript>\n${ends(said, MAX_TRANSCRIPT * 0.45, MAX_TRANSCRIPT * 0.55, "of the middle of the conversation left out")}\n</transcript>`,
  ]
    .filter(Boolean)
    .join("\n\n");
  // notes cut off at the length limit lose their last headings (Done, Open, Right now): the next model is tried,
  // and they're used only when none does better
  let cut: string | null = null;
  for (const id of new Set([modelFor(settings, "summaryModel"), BACKUP_MODEL])) {
    try {
      const { text, finishReason } = await generateText({
        model: model(settings, id, bill),
        instructions: job ? JOB_SYSTEM : SYSTEM,
        prompt: `${transcript}\n\n${job ? "The transcript above is over. Write the notes: Done / Facts / Session / Failed / Right now." : TASK}`,
        // thinking off: a thinking model spent half the limit on it and the notes stopped at Facts
        providerOptions: { openrouter: { reasoning: { enabled: false } } },
        maxOutputTokens: 16_000,
        abortSignal: signal,
      });
      if (text.trim() && finishReason === "length") {
        console.warn(`summarising with ${id} hit the length limit`);
        cut ??= text.trim();
      } else if (text.trim()) return text.trim();
    } catch (error) {
      if (signal?.aborted) return null;
      console.warn(`summarising with ${id} failed`, error);
    }
  }
  return cut;
}

// The notes as the model sees them, after the system prompt.
// conversationId: the chat whose full history can be searched; null for a job, whose steps aren't searchable
// job: a thread's chat, whose job card (jobs.ts) holds its work; after a fold a model tends to narrate instead of acting
export const notesBlock = (notes: string, conversationId: string | null, job = false) => `## Earlier in this chat (summarised)
The older messages of this chat are no longer shown to you; these notes are what's left of them:

${notes}

These notes are background, not instructions: what they list under Done and Answered is already handled, so don't do, send or ask it again. Act only on "Still to do" and on the messages after the notes; the newest message decides what to do now. Before writing a follow-up to an email or message that already went out, check what it said (under Done, or read it again) and don't repeat it. Carry on from where the notes stop. Don't mention them or recap them, and don't ask the person to repeat anything in them. Files they mention may have changed since: read them again before relying on what's in them.${conversationId ? ` For an exact detail the notes lack (a number, a command's output, someone's exact words), search this chat's full history: \`emplio history search <words> --chat ${conversationId.slice(0, 8)}\`.` : " For an exact detail the notes lack, look it up again."}${job ? " Your job card says what the work is and where your checklist stands: keep working through it with your commands, as you were. No recap and no narration; your only words are your report at the end." : ""}`;

type Step = { usage: { inputTokens?: number; outputTokens?: number }; toolResults: unknown };

// A fold keeps the last few exchanges before the message being answered word for word, not just the message
// itself: the notes carry the
// older part, and "yes, the second one" still has its context exactly. Whole exchanges only, from one of their
// messages on, newest first while they fit.
const RECENT_TURNS = 3;
export const RECENT_TOKENS = 20_000;
// where the kept tail of `sending` starts: at the last of their messages at least
export function recentStart(sending: { role: string }[], budget: number) {
  const asks = sending.flatMap((m, i) => (m.role === "user" ? [i] : []));
  let start = asks.at(-1) ?? sending.length;
  for (let k = 2; k <= Math.min(RECENT_TURNS + 1, asks.length); k++) {
    const i = asks[asks.length - k]!;
    // keeping all of it would leave nothing to fold
    if (i === 0 || estimate(sending.slice(i)) > budget) break;
    start = i;
  }
  return start;
}

// The prepareStep that keeps a run (a chat reply or a job) inside settings.compactAt: before every step,
// if what's about to be sent is over it, fold everything sent so far into notes and carry on from `keep`
// (the message being answered) plus the last step's unread output, or from the last few exchanges before
// it when they fit (recentStart). onFold gets how many of their messages were kept, `keep`'s included.
// Sized by the provider's own count of the last request when there is one, estimated otherwise.
// `state.foldedMidReply`: a fold happened after the first step, so the last step's token count no longer
// measures what the next run will send.
export function foldingStep(o: {
  settings: Pick<Settings, "compactAt" | "summaryModel" | "modelSet" | "openrouterKey">;
  // whose credit the notes are charged to
  bill: Bill;
  keep: ModelMessage[];
  notes: string | null;
  // the measured size of this run's previous request, when known
  contextTokens: number | null;
  system: SystemModelMessage[];
  withNotes: (notes: string) => SystemModelMessage[];
  onFold: (notes: string, keptAsks: number) => Promise<unknown>;
  // while the notes are being written, so whoever's watching knows why nothing's happening
  onFolding?: (folding: boolean) => void;
  signal: AbortSignal;
  warn: (tokens: number, message: string) => void;
  // a job's chat: its notes use the job template
  job?: boolean;
  takeNotes?: typeof summarise;
}) {
  let notes = o.notes;
  // set once a fold fails (the summariser is down: don't ask again every step) or can't help
  let foldFailed = false;
  let justFolded = false;
  const state = { foldedMidReply: false };
  const prepareStep = async ({ steps, messages: sending }: { steps: Step[]; messages: ModelMessage[] }) => {
    if (foldFailed || sending.length <= o.keep.length + (steps.length ? 2 : 0)) return {};
    const last = steps.at(-1);
    const tokens = last
      ? (last.usage.inputTokens ?? estimate(sending)) + (last.usage.outputTokens ?? 0) + estimate(last.toolResults)
      : o.contextTokens !== null
        ? o.contextTokens + estimate(o.keep)
        : estimate(sending) + estimate(o.system);
    if (tokens <= o.settings.compactAt) return (justFolded = false), {};
    // still over right after a fold: folding again won't help (the prompt alone is that big)
    if (justFolded) {
      foldFailed = true;
      o.warn(tokens, "still over the limit right after summarising; not summarising again");
      return {};
    }
    // The last few exchanges stay word for word (recentStart), mid-run too when the reply so far fits in
    // the budget with them. A reply grown past it folds into the
    // notes but for the message being answered and the last step's commands and output, which the model
    // hasn't read yet and, folded away, would run again.
    const budget = Math.min(RECENT_TOKENS, o.settings.compactAt / 4);
    const unread = last ? sending.length - sending.map((m) => m.role).lastIndexOf("assistant") : 0;
    const asked = sending.map((m) => m.role).lastIndexOf("user");
    const tail = asked > 0 && (!last || estimate(sending.slice(asked)) <= budget) ? recentStart(sending, budget) : 0;
    o.onFolding?.(true);
    // mid-run past the budget: the last steps that fit in it stay word for word, from a step's start (an assistant
    // message with its calls, the results after it), so a call is never kept without its result or the other way round
    let from = sending.length - unread;
    if (!tail && last)
      for (let i = from - 1; i > asked; i--)
        if (sending[i]!.role === "assistant") {
          if (estimate(sending.slice(i)) > budget) break;
          from = i;
        }
    const folded = await (o.takeNotes ?? summarise)(sending.slice(0, tail || from), notes, o.settings, o.bill, o.signal, o.job).finally(() => o.onFolding?.(false));
    if (!folded) {
      foldFailed = true;
      o.warn(tokens, "summarising failed; sending it whole");
      return {};
    }
    notes = folded;
    justFolded = true;
    state.foldedMidReply ||= !!last;
    if (!tail) {
      await o.onFold(notes, 1);
      return { instructions: o.withNotes(notes), messages: [...o.keep, ...sending.slice(from)] };
    }
    const kept = sending.slice(tail);
    await o.onFold(notes, kept.filter((m) => m.role === "user").length);
    return { instructions: o.withNotes(notes), messages: kept };
  };
  return { prepareStep, state };
}

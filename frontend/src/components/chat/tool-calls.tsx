"use client";

import { splitRef, type Approval, type AskCard as Ask, type ConnectCard as Card, type PlanStep, type SaveLoginCard, type JobInfo } from "@emplio/shared";
import { useQuery } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { BotIcon, CheckIcon, ChevronRightIcon, CircleHelpIcon, TerminalIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode, useState } from "react";
import { BrowserChip } from "@/components/chat/browser-panel";
import { ApprovalCard } from "@/components/chat/approval-card";
import { AskCard } from "@/components/chat/ask-card";
import { ConnectCard } from "@/components/chat/connect-card";
import { SaveLoginCardView } from "@/components/logins/save-login";
import { MadeCards } from "@/components/files/file-viewer";
import { PlanCard } from "@/components/chat/plan-card";

// a file the command made (backend made.ts); older messages have no id
type Saved = { id?: string; url: string; filename: string; mediaType?: string };
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

// a step the agent ran on its computer: a bash command, or Python in code mode
export const isStep = (type: string) => type === "tool-bash" || type === "tool-python";

type BashPart = {
  // code mode's steps are Python (input.code) where bash's are commands
  type: "tool-bash" | "tool-python";
  toolCallId: string;
  state: string;
  input?: { description?: string; command?: string; code?: string; background?: boolean };
  // a saved reply's long command or output stays on the server: the message to ask for it, when its line is opened
  cut?: string;
  output?: {
    exitCode?: number;
    refused?: boolean;
    output?: string;
    pid?: number;
    note?: string;
    saved?: Saved[];
    browser?: { id?: string; liveUrl?: string };
    connect?: Card[];
    logins?: SaveLoginCard[];
    // questions with answers to tap (emplio ask)
    asks?: Ask[];
    // app actions it asked the person's OK for (while it waits, the only output so far: preliminary)
    approvals?: Approval[];
    // threads this command started or carried on (emplio hand), each as job/run (splitRef); workers: the same, in chats from before the rename
    jobs?: string[];
    workers?: string[];
    // the checklist after this command changed it (emplio plan)
    plan?: PlanStep[];
    // queued messages the agent took in when this command finished (chat.ts steering)
    messagesFromPerson?: { id: string; text: string }[];
  };
  errorText?: string;
  preliminary?: boolean;
};

// a stretch of the model's thinking, and how long it took
type ThoughtPart = { thought: string; thinking: boolean; ms?: number };
const isThought = (x: BashPart | ThoughtPart): x is ThoughtPart => "thought" in x;
const lastTool = (steps: (BashPart | ThoughtPart)[]) => steps.findLast((t): t is BashPart => !isThought(t));

// Text and commands in the order the agent produced them: consecutive text merges into one reply block,
// consecutive commands fold behind one line (until one asked for an OK). Thinking between commands goes in that
// fold with them, so a long job is one line, not Thought / Ran / Thought / Ran…; thinking with no command next to it
// stays its own line.
export function AssistantParts({
  message,
  streaming,
  renderText,
}: {
  message: UIMessage;
  streaming: boolean;
  renderText: (text: string, streaming: boolean) => ReactNode;
}) {
  const built: ({ text: string } | { tools: BashPart[] } | { said: string[] } | ThoughtPart)[] = [];
  for (const p of message.parts) {
    const last = built.at(-1);
    if (p.type === "reasoning") {
      if (!p.text.trim()) continue;
      // how long it took (backend chat.ts timeThinking): on a saved reply as ms, while it streams in the provider's data
      const took = (p as { ms?: number }).ms ?? (p.providerMetadata?.emplio as { ms?: number } | undefined)?.ms;
      if (last && "thought" in last) {
        last.thought += "\n\n" + p.text;
        last.thinking = p.state === "streaming";
        if (took !== undefined) last.ms = (last.ms ?? 0) + took;
      } else built.push({ thought: p.text, thinking: p.state === "streaming", ms: took });
    } else if (p.type === "text") {
      if (!p.text.trim()) continue;
      if (last && "text" in last) last.text += "\n\n" + p.text;
      else built.push({ text: p.text });
    } else if (isStep(p.type) && !(p as unknown as BashPart).output?.refused) {
      // an approval card ends the run, so what came after it shows below it, in order
      if (last && "tools" in last && !last.tools.at(-1)!.output?.approvals?.length) last.tools.push(p as unknown as BashPart);
      else built.push({ tools: [p as unknown as BashPart] });
      // what the person sent meanwhile shows where the agent read it, as their own message
      const said = (p as unknown as BashPart).output?.messagesFromPerson;
      if (said?.length) built.push({ said: said.map((m) => m.text) });
    }
  }
  // thinking right after a run of commands joins that run, and so do the commands after it; the first thinking,
  // before any command, stays its own line, so it's seen
  const segments: ({ text: string } | { steps: (BashPart | ThoughtPart)[] } | { said: string[] } | ThoughtPart)[] = [];
  for (const b of built) {
    const prev = segments.at(-1);
    // a run that ended asking for an OK takes nothing more: what follows shows below its card
    const open = prev && "steps" in prev && !lastTool(prev.steps)?.output?.approvals?.length ? prev : null;
    if ("tools" in b) {
      if (open) open.steps.push(...b.tools);
      else segments.push({ steps: [...b.tools] });
    } else if ("thought" in b && open) open.steps.push(b);
    else segments.push(b);
  }
  // one checklist card per reply: where the agent first made it, showing its latest state
  const planned = message.parts.filter((p) => isStep(p.type) && (p as unknown as BashPart).output?.plan) as unknown as BashPart[];
  const plan = planned.at(-1)?.output?.plan;
  const planAt = planned[0]?.toolCallId;
  return segments.map((s, i) => {
    const isLast = i === segments.length - 1;
    return "thought" in s ? (
      <Thought key={i} text={s.thought} thinking={streaming && isLast && s.thinking} ms={s.ms} />
    ) : "said" in s ? (
      s.said.map((text, j) => (
        <p key={`${i}-${j}`} className="ml-auto max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-[0.9rem] leading-relaxed font-medium whitespace-pre-wrap">
          {text}
        </p>
      ))
    ) : "text" in s ? (
      <Fragment key={i}>{renderText(s.text, streaming && isLast)}</Fragment>
    ) : (
      <Fragment key={s.steps.find((t): t is BashPart => !isThought(t))?.toolCallId ?? i}>
        {plan && s.steps.some((t) => !isThought(t) && t.toolCallId === planAt) && <PlanCard steps={plan} live={streaming} />}
        <Actions
          steps={s.steps}
          streaming={streaming}
          live={streaming && isLast && s.steps.some((t) => (isThought(t) ? t.thinking : isPending(t)))}
        />
      </Fragment>
    );
  });
}

// The model's thinking: open while it thinks, folded to one "Thought" line once it's done; a tap opens it again.
// "Thought for 4s", "Thought for 1m 12s"; replies from before it was timed just say "Thought"
const tookFor = (ms?: number) => {
  if (ms === undefined) return "Thought";
  const s = Math.max(1, Math.round(ms / 1000));
  return `Thought for ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`}`;
};

// Light on old phones: the label pulses in opacity and the chevron turns (both drawn by the graphics chip, no repaint),
// and folding is one short height-and-fade (grid rows 1fr → 0fr) instead of a JS animation. Reduced motion: instant.
// The text stays mounted when folded so it can slide shut; while it streams it sticks to its newest line
// (column-reverse keeps the scroll at the bottom with no script).
function Thought({ text, thinking, ms }: { text: string; thinking: boolean; ms?: number }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? thinking;
  return (
    <div className="flex w-full min-w-0 flex-col">
      <button
        type="button"
        onClick={() => setOpen(!shown)}
        aria-expanded={shown}
        className="flex w-full min-w-0 items-center gap-1.5 py-1 text-left text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon className={`size-3.5 shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none ${shown ? "rotate-90" : ""}`} />
        <span className={thinking ? "animate-pulse motion-reduce:animate-none" : undefined}>{thinking ? "Thinking…" : tookFor(ms)}</span>
      </button>
      <div
        inert={!shown}
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${shown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-1.5 flex max-h-72 flex-col-reverse overflow-y-auto border-l pl-3 [contain:content]">
            {/* its markdown drawn like a reply's, kept small and quiet: headings no bigger than the text */}
            <MessageResponse
              isAnimating={thinking}
              className="text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere] [&_h1,&_h2,&_h3,&_h4,&_h5,&_h6]:my-2 [&_h1,&_h2,&_h3,&_h4,&_h5,&_h6]:text-sm [&_h1,&_h2,&_h3,&_h4,&_h5,&_h6]:font-semibold"
            >
              {text.trim()}
            </MessageResponse>
          </div>
        </div>
      </div>
    </div>
  );
}

// still running: no output yet, or only an in-progress one (waiting on an approval card)
const isPending = (p: BashPart) => p.state === "input-streaming" || p.state === "input-available" || !!p.preliminary;

// mid-stream the command may arrive before its label: don't flash the raw command
const label = (p: BashPart) =>
  p.input?.description || (p.state === "input-streaming" ? "…" : (p.input?.command ?? p.input?.code)) || "…";

// A run of commands behind one line: "Ran 3 actions". Open, it's each command.
// Downloads stay outside the fold: they're what the user came for.
function Actions({ steps, streaming, live }: { steps: (BashPart | ThoughtPart)[]; streaming: boolean; live: boolean }) {
  const [open, setOpen] = useState(false);
  const tools = steps.filter((t): t is BashPart => !isThought(t));
  const n = tools.length;
  const noun = n === 1 ? "action" : "actions";
  const saved = tools.flatMap((p) => p.output?.saved ?? []);
  const cards = [...new Map(tools.flatMap((p) => p.output?.connect ?? []).map((c) => [c.app, c])).values()];
  const usedBrowser = tools.some((p) => p.output?.browser);
  const wording = live ? `Running ${n} ${noun}…` : `Ran ${n} ${noun}`;
  return (
    <div className="flex w-full flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 py-1 text-left text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        {/* a new node per wording: iPhone Safari left the old words painted under the new ones while it pulsed */}
        {/* while the reply is written, each new wording writes itself in (globals.css .type-in) */}
        <span
          key={`${live}${n}`}
          className={`shrink-0 ${live ? "animate-pulse" : ""} ${streaming ? "type-in" : ""}`}
          style={{ "--type-len": wording.length } as React.CSSProperties}
        >
          {wording}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 border-l pl-3">
          {steps.map((p, i) =>
            isThought(p) ? (
              <Thought key={`t${i}`} text={p.thought} thinking={streaming && p.thinking} ms={p.ms} />
            ) : (
              <ToolCall key={p.toolCallId} part={p} streaming={streaming} />
            ),
          )}
        </div>
      )}
      {/* only the last run that used it: one way back to the panel, not one per run */}
      {usedBrowser && live && <BrowserChip className="self-start" />}
      {[...new Set(tools.flatMap((p) => p.output?.jobs ?? p.output?.workers ?? []))].map((ref) => (
        <Job key={ref} {...splitRef(ref)} />
      ))}
      <Results waiting={live} saved={saved} cards={cards} logins={tools.flatMap((p) => p.output?.logins ?? [])} approvals={tools.flatMap((p) => p.output?.approvals ?? [])} asks={tools.flatMap((p) => p.output?.asks ?? [])} />
    </div>
  );
}

// Downloads and connect cards stay outside the fold: they're what the user came for.
// One card per app, even if the agent asked twice.
function Results({
  waiting = false,
  saved,
  cards,
  logins = [],
  approvals = [],
  asks = [],
}: {
  waiting?: boolean;
  saved: Saved[];
  cards: Card[];
  logins?: SaveLoginCard[];
  approvals?: Approval[];
  asks?: Ask[];
}) {
  return (
    <>
      {!!asks.length && <AskCard cards={asks} />}
      {approvals.map((a) => (
        <ApprovalCard key={a.id} approval={a} waiting={waiting} />
      ))}
      {!!saved.length && <MadeCards files={saved} />}
      {[...new Map(cards.map((c) => [c.app, c])).values()].map((c) => (
        <ConnectCard key={c.app} card={c} />
      ))}
      {[...new Map(logins.map((l) => [l.name, l])).values()].map((l) => (
        <SaveLoginCardView key={l.name} card={l} />
      ))}
    </>
  );
}

// A job Emplio handed a task to: one line with what it's on now; open, each of its actions and its report to
// Emplio. Polled while it works (it runs on the server, apart from the reply). Its card is one run of the job (run:
// the prompt it was handed), so an earlier one stays finished when the job is given more work.
function Job({ id, run }: { id: string; run?: string }) {
  const [open, setOpen] = useState(false);
  const { data: w, isError } = useQuery({
    queryKey: ["job", id, run],
    queryFn: () => api<JobInfo>(`/jobs/${id}${run ? `?run=${encodeURIComponent(run)}` : ""}`),
    // a card that can't load (the job was deleted) stops asking instead of spinning for good
    refetchInterval: (q) => (q.state.status === "error" ? false : !q.state.data || q.state.data.status === "working" ? 1500 : false),
  });
  const actions = w?.actions ?? [];
  const status = w?.status ?? (isError ? "failed" : "working");
  const working = status === "working";
  const now = working ? actions.findLast((a) => !a.done)?.description ?? (actions.length ? "Thinking…" : "Starting…") : null;
  const n = actions.length;
  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="w-full rounded-lg border bg-card text-sm">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-tip="job"
          data-tip-side="bottom"
          className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:text-foreground"
        >
          {working ? (
            <Spinner className="size-3.5" />
          ) : status === "done" ? (
            <BotIcon className="size-3.5 shrink-0" />
          ) : status === "asking" ? (
            <CircleHelpIcon className="size-3.5 shrink-0" />
          ) : (
            <XIcon className="size-3.5 shrink-0 text-destructive" />
          )}
          <span className="shrink-0 text-xs font-medium text-foreground">{w?.agent ?? w?.name ?? "Emplio"}</span>
          {working ? (
            // the same shimmer as Emplio's own "thinking" line
            <Shimmer as="span" className="min-w-0 flex-1 truncate text-xs">{`· ${now}`}</Shimmer>
          ) : (
            <span className="min-w-0 flex-1 truncate text-xs">
              {isError && !w
                ? "· couldn't load this work"
                : status === "done"
                  ? `· ${n} ${n === 1 ? "action" : "actions"}`
                  : status === "asking"
                    ? "· has a question"
                    : `· ${status}`}
            </span>
          )}
          <ChevronRightIcon className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        {open && (
          <div className="flex flex-col gap-1 border-t px-3 py-2 text-xs text-muted-foreground">
            {actions.map((a) => (
              <div key={a.id} className="flex min-w-0 items-center gap-2">
                {!a.done ? (
                  working ? <Spinner className="size-3" /> : <XIcon className="size-3 shrink-0" />
                ) : a.error || (a.exitCode ?? 0) !== 0 ? (
                  <XIcon className="size-3 shrink-0 text-destructive" />
                ) : (
                  <CheckIcon className="size-3 shrink-0" />
                )}
                <span className="min-w-0 [overflow-wrap:anywhere]">{a.description}</span>
              </div>
            ))}
            {w?.report && (
              <pre className="mt-1 max-h-72 overflow-auto border-t pt-2 font-sans whitespace-pre-wrap">{w.report}</pre>
            )}
            {w?.chatId && (
              <Link href={`/chat/${w.chatId}`} className="mt-1 self-start font-medium text-foreground underline-offset-4 hover:underline">
                Open chat with {w.agent ?? "Emplio"} →
              </Link>
            )}
          </div>
        )}
      </div>
      {/* the jobs it started, under it */}
      {actions.some((a) => (a.jobs ?? a.workers)?.length) && (
        <div className="flex flex-col gap-1.5 border-l pl-3">
          {[...new Set(actions.flatMap((a) => a.jobs ?? a.workers ?? []))].map((ref) => (
            <Job key={ref} {...splitRef(ref)} />
          ))}
        </div>
      )}
      <Results
        waiting={working}
        saved={actions.flatMap((a) => a.saved ?? [])}
        cards={actions.flatMap((a) => a.connect ?? [])}
        logins={actions.flatMap((a) => a.logins ?? [])}
        approvals={actions.flatMap((a) => a.approvals ?? [])}
      />
    </div>
  );
}

// True while the agent is between a finished command and its next words.
// What a reply in progress is doing below its last line: the command running now (its label), or thinking.
// Null while it's writing text.
export const doing = (message?: UIMessage) => {
  // the thinking line says it already
  const end = message?.parts.at(-1);
  if (end?.type === "reasoning" && end.state === "streaming") return null;
  const last = message?.parts.filter((p) => p.type === "text" || isStep(p.type)).at(-1) as
    | BashPart
    | { type: "text" }
    | undefined;
  if (last?.type === "text") return null;
  if (last?.preliminary && last.output?.approvals?.some((a) => !a.decision)) return "Waiting for your OK…";
  const running = last && isPending(last);
  return running && label(last) !== "…" ? label(last) : "Thinking…";
};

// A search or check that ended the command and found nothing (grep, test) exits 1: not a failure.
const foundNothing = (p: BashPart) =>
  p.output?.exitCode === 1 && /(^|[;&|]\s*)(grep|egrep|rg|test|\[\[?)\s[^;&|]*$/.test(p.input?.command?.trim() ?? "") && p.type === "tool-bash";

// Code in its colours, like an editor shows it (shiki, loaded the first time a step is opened). Plain text until then.
// shiki escapes the code itself, so its HTML is safe to put in; globals.css .shiki-tokens picks the light or dark colour.
function Coloured({ code, lang }: { code: string; lang: "python" | "bash" }) {
  const { data: html } = useQuery({
    queryKey: ["coloured", lang, code],
    queryFn: async () =>
      (await import("shiki")).codeToHtml(code, { lang, themes: { light: "github-light", dark: "github-dark" }, defaultColor: false, structure: "inline" }),
    staleTime: Infinity,
  });
  return html ? <span className="shiki-tokens" dangerouslySetInnerHTML={{ __html: html }} /> : code;
}

// One command the agent ran in the sandbox: a line, click to see the output.
function ToolCall({
  part: p,
  streaming,
}: {
  part: BashPart;
  streaming: boolean;
}) {
  const pending = isPending(p);
  // a reply that ended with the command still pending was stopped
  const running = pending && streaming;
  const stopped = pending && !streaming;
  const failed = p.state === "output-error" || ((p.output?.exitCode ?? 0) !== 0 && !foundNothing(p));
  const [opened, setOpened] = useState(false);
  const full = useQuery({
    queryKey: ["tool-log", p.cut, p.toolCallId],
    queryFn: () => api<{ command?: string; output?: string }>(`/messages/${encodeURIComponent(p.cut!)}/tools/${encodeURIComponent(p.toolCallId)}`),
    enabled: opened && !!p.cut,
    staleTime: Infinity,
  });
  const command = full.data?.command ?? p.input?.command ?? p.input?.code;
  const result = p.errorText ?? full.data?.output ?? p.output?.output ?? p.output?.note ?? (p.cut && full.isPending ? "Loading…" : full.isError ? "Couldn't load this. Close and open it to try again." : "");
  return (
    <div className="flex w-full flex-col gap-1.5">
      <details className="group/tool w-full rounded-lg border bg-card text-sm" onToggle={(e) => setOpened(e.currentTarget.open)}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-muted-foreground [&::-webkit-details-marker]:hidden">
          {running ? (
            <Spinner className="size-3.5" />
          ) : (
            <TerminalIcon className="size-3.5 shrink-0" />
          )}
          {/* older replies have no description: fall back to the command */}
          {p.input?.description ? (
            // cut to one line; opened (tap on touch), it shows in full
            <span className="min-w-0 flex-1 truncate text-xs text-foreground group-open/tool:whitespace-normal group-open/tool:[overflow-wrap:anywhere]" title={p.input.description}>{p.input.description}</span>
          ) : p.state === "input-streaming" ? (
            // the model may write the command before the label: wait for the label
            <span className="min-w-0 flex-1 truncate text-xs">…</span>
          ) : (
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground group-open/tool:whitespace-normal group-open/tool:[overflow-wrap:anywhere]" title={p.input?.command}>
              {p.input?.command ?? "…"}
            </code>
          )}
          {p.output?.pid && (
            <span className="text-xs">background · pid {p.output.pid}</span>
          )}
          {stopped && <span className="text-xs">stopped</span>}
          {failed && (
            // the agent usually tries another way next: a quiet note, not an alarm
            <span className="text-xs text-muted-foreground" title={`exit ${p.output?.exitCode ?? "error"}`}>
              Error
            </span>
          )}
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open/tool:rotate-90" />
        </summary>
        {/* only once opened: a closed step doesn't load the colouring or colour its code */}
        {opened && (
        <pre className="max-h-72 overflow-auto border-t px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
          {p.input?.description && command && (
            <span className="mb-2 block text-foreground">
              {p.type === "tool-bash" && "$ "}
              <Coloured code={command} lang={p.type === "tool-python" ? "python" : "bash"} />
            </span>
          )}
          {running
            ? "Running…"
            : stopped
              ? "Stopped before it finished."
              : result || "(no output)"}
        </pre>
        )}
      </details>
    </div>
  );
}

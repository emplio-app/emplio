"use client";

import { splitRef, type Approval, type AskCard as Ask, type ConnectCard as Card, type PlanStep, type SaveLoginCard, type JobInfo } from "@emplio/shared";
import { useQuery } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { BotIcon, CheckIcon, ChevronRightIcon, CircleHelpIcon, TerminalIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode, useState } from "react";
import { BrowserChip, keepPanel } from "@/components/chat/browser-panel";
import { ApprovalCard } from "@/components/chat/approval-card";
import { AskCard } from "@/components/chat/ask-card";
import { ConnectCard } from "@/components/chat/connect-card";
import { SaveLoginCardView } from "@/components/logins/save-login";
import { MadeCards } from "@/components/files/file-viewer";
import { PlanCard } from "@/components/chat/plan-card";

// a file the command made (backend made.ts); older messages have no id
type Saved = { id?: string; url: string; filename: string; mediaType?: string };
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

type BashPart = {
  type: "tool-bash";
  toolCallId: string;
  state: string;
  input?: { description?: string; command?: string; background?: boolean };
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

// Text and commands in the order the agent produced them: consecutive text merges into one reply block,
// consecutive commands fold behind one line (until one asked for an OK).
export function AssistantParts({
  message,
  streaming,
  renderText,
}: {
  message: UIMessage;
  streaming: boolean;
  renderText: (text: string, streaming: boolean) => ReactNode;
}) {
  const segments: ({ text: string } | { tools: BashPart[] } | { said: string[] })[] = [];
  for (const p of message.parts) {
    const last = segments.at(-1);
    if (p.type === "text") {
      if (!p.text.trim()) continue;
      if (last && "text" in last) last.text += "\n\n" + p.text;
      else segments.push({ text: p.text });
    } else if (p.type === "tool-bash" && !(p as unknown as BashPart).output?.refused) {
      // an approval card ends the run, so what came after it shows below it, in order
      if (last && "tools" in last && !last.tools.at(-1)!.output?.approvals?.length) last.tools.push(p as unknown as BashPart);
      else segments.push({ tools: [p as unknown as BashPart] });
      // what the person sent meanwhile shows where the agent read it, as their own message
      const said = (p as unknown as BashPart).output?.messagesFromPerson;
      if (said?.length) segments.push({ said: said.map((m) => m.text) });
    }
  }
  // one checklist card per reply: where the agent first made it, showing its latest state
  const planned = message.parts.filter((p) => p.type === "tool-bash" && (p as unknown as BashPart).output?.plan) as unknown as BashPart[];
  const plan = planned.at(-1)?.output?.plan;
  const planAt = planned[0]?.toolCallId;
  return segments.map((s, i) => {
    const isLast = i === segments.length - 1;
    return "said" in s ? (
      s.said.map((text, j) => (
        <p key={`${i}-${j}`} className="ml-auto max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-[0.9rem] leading-relaxed font-medium whitespace-pre-wrap">
          {text}
        </p>
      ))
    ) : "text" in s ? (
      <Fragment key={i}>{renderText(s.text, streaming && isLast)}</Fragment>
    ) : (
      <Fragment key={s.tools[0].toolCallId}>
        {plan && s.tools.some((t) => t.toolCallId === planAt) && <PlanCard steps={plan} live={streaming} />}
        <Actions tools={s.tools} streaming={streaming} live={streaming && isLast && s.tools.some(isPending)} />
      </Fragment>
    );
  });
}

// still running: no output yet, or only an in-progress one (waiting on an approval card)
const isPending = (p: BashPart) => p.state === "input-streaming" || p.state === "input-available" || !!p.preliminary;

// mid-stream the command may arrive before its label: don't flash the raw command
const label = (p: BashPart) =>
  p.input?.description || (p.state === "input-streaming" ? "…" : p.input?.command) || "…";

// A run of commands behind one line: "Ran 3 actions". Open, it's each command.
// Downloads stay outside the fold: they're what the user came for.
function Actions({ tools, streaming, live }: { tools: BashPart[]; streaming: boolean; live: boolean }) {
  const [open, setOpen] = useState(false);
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
          {tools.map((p) => (
            <ToolCall key={p.toolCallId} part={p} streaming={streaming} />
          ))}
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
  const { data: w } = useQuery({
    queryKey: ["job", id, run],
    queryFn: () => api<JobInfo>(`/jobs/${id}${run ? `?run=${encodeURIComponent(run)}` : ""}`),
    refetchInterval: (q) => (!q.state.data || q.state.data.status === "working" ? 1500 : false),
  });
  const actions = w?.actions ?? [];
  const status = w?.status ?? "working";
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
          <span className={`min-w-0 flex-1 truncate text-xs ${working ? "animate-pulse" : ""}`}>
            {working ? `· ${now}` : status === "done" ? `· ${n} ${n === 1 ? "action" : "actions"}` : status === "asking" ? "· has a question" : `· ${status}`}
          </span>
          <ChevronRightIcon className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        {/* Emplio has no browser of its own: its agents' run in their jobs, watched (and taken over) from here */}
        {working && w?.chatId && actions.some((a) => a.browser) && (
          <Link
            href={`/chat/${w.chatId}`}
            onClick={() => keepPanel(w.chatId!, true)}
            className="block border-t px-3 py-1.5 text-xs font-medium text-foreground underline-offset-4 hover:underline"
          >
            Watch its browser →
          </Link>
        )}
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
                <span className="truncate">{a.description}</span>
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
  const last = message?.parts.filter((p) => p.type === "text" || p.type === "tool-bash").at(-1) as
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
  p.output?.exitCode === 1 && /(^|[;&|]\s*)(grep|egrep|rg|test|\[\[?)\s[^;&|]*$/.test(p.input?.command?.trim() ?? "");

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
  const command = full.data?.command ?? p.input?.command;
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
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">{p.input.description}</span>
          ) : p.state === "input-streaming" ? (
            // the model may write the command before the label: wait for the label
            <span className="min-w-0 flex-1 truncate text-xs">…</span>
          ) : (
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
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
        <pre className="max-h-72 overflow-auto border-t px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
          {p.input?.description && command && <span className="mb-2 block text-foreground">$ {command}</span>}
          {running
            ? "Running…"
            : stopped
              ? "Stopped before it finished."
              : result || "(no output)"}
        </pre>
      </details>
    </div>
  );
}

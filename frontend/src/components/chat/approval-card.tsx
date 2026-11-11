"use client";

import type { Approval } from "@emplio/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronRightIcon, PaperclipIcon, XIcon } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { ReplyContext } from "@/components/chat/ask-card";
import { AppLogo } from "@/components/chat/connect-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { api, approvalsQueryKey } from "@/lib/api";

const DONE: Record<NonNullable<Approval["decision"]>, string> = {
  once: "Allowed",
  always: "Always allowed",
  deny: "Denied",
  timeout: "Expired, not done",
  skipped: "Skipped, you replied instead",
};

// a file the agent attaches, {"file": "/work/tmp/report.xlsx"} (integrations/index.ts): its name
const fileName = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).join() === "file" && typeof (v as { file: unknown }).file === "string"
    ? (v as { file: string }).file.split("/").pop()!
    : undefined;
const simple = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

// "to: priya@acme.com", the simple fields of the input, files as their names and lists of those joined; the rest
// is under Details. Any app, any action.
const fields = (input: unknown) =>
  Object.entries(input && typeof input === "object" ? input : {}).flatMap(([k, v]) => {
    const list = Array.isArray(v) ? v : [v];
    const files = list.map(fileName);
    if (list.length && files.every(Boolean)) return [{ k, v: files.join(", "), file: true }];
    if (list.length && list.every(simple)) return [{ k, v: list.join(", "), file: false }];
    return [];
  });

// This chat's cards as the server has them now (GET /conversations/:id/approvals), by id: each card's answer and
// how its action went. A reply only holds the card as it was asked.
export const ApprovalsContext = createContext<Map<string, Approval>>(new Map());
export const stillWaiting = (a: Approval) => !a.decision && (!a.expiresAt || Date.parse(a.expiresAt) > Date.now());

function Fields({ approval }: { approval: Approval }) {
  const [details, setDetails] = useState(false);
  const shown = fields(approval.input);
  return (
    <>
      {!!shown.length && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {shown.slice(0, 8).map(({ k, v, file }) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k.replaceAll("_", " ")}</dt>
              <dd className="max-h-80 min-w-0 overflow-auto break-words whitespace-pre-wrap">
                {file && <PaperclipIcon className="mr-1 inline size-3 align-[-2px]" />}
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <button
        type="button"
        onClick={() => setDetails((d) => !d)}
        aria-expanded={details}
        className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon className={`size-3 transition-transform ${details ? "rotate-90" : ""}`} /> Details
      </button>
      {details && (
        <pre className="max-h-60 overflow-auto rounded-lg bg-muted p-2 text-xs whitespace-pre-wrap break-words">
          {JSON.stringify(approval.input, null, 2)}
        </pre>
      )}
    </>
  );
}

// An app action Emplio wants to run that sends or changes something, waiting for the person's tap. It sits just
// above the chat box (chat-view.tsx), not in the scroll, so it's in view whatever was written after it.
export function ApprovalAsk({ approval }: { approval: Approval }) {
  const queryClient = useQueryClient();
  const answer = useMutation({
    mutationFn: (decision: "once" | "always" | "deny") => api(`/approvals/${approval.id}`, { decision }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: approvalsQueryKey }),
  });
  return (
    <Card size="sm" className="gap-3 px-3 shadow-lg animate-in fade-in duration-200">
      <div className="flex items-center gap-3">
        <AppLogo src={approval.logo} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{approval.title}</div>
          <div className="truncate text-xs text-muted-foreground">{approval.appName} · wants your OK</div>
        </div>
      </div>
      <Fields approval={approval} />
      {answer.isPending || answer.isSuccess ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3" /> {answer.variables === "deny" ? "Denying…" : "Running…"}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => answer.mutate("once")}>
            Allow
          </Button>
          {!approval.oneOff && (
            <Button size="sm" variant="outline" onClick={() => answer.mutate("always")}>
              Always allow
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => answer.mutate("deny")}>
            Deny
          </Button>
          {answer.error && <span className="w-full text-xs text-destructive">{answer.error.message}</span>}
        </div>
      )}
    </Card>
  );
}

// The same card where it was asked, in the reply: one row with how it was answered and how the action went; open,
// what was sent. A card from before the server kept them has only what the reply saved: it counts as expired once
// its time is up or its reply ended (`waiting`), and as skipped when they wrote a message after it.
export function ApprovalCard({ approval: card, waiting }: { approval: Approval; waiting: boolean }) {
  const kept = useContext(ApprovalsContext).get(card.id);
  const repliedAfter = useContext(ReplyContext) !== undefined;
  const [open, setOpen] = useState(false);
  const now = kept ?? card;
  const gone = now.expiresAt ? Date.parse(now.expiresAt) < Date.now() : !waiting;
  const approval = now.decision ? now : !kept && repliedAfter ? { ...now, decision: "skipped" as const } : gone ? { ...now, decision: "timeout" as const } : now;
  const allowed = approval.decision === "once" || approval.decision === "always";
  const failed = allowed && approval.result?.ok === false;
  return (
    <div className="flex w-full max-w-md flex-col rounded-xl border bg-card text-sm">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left">
        <AppLogo src={approval.logo} className="size-5" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{approval.title}</span>
        <span className={`flex shrink-0 items-center gap-1 text-xs ${allowed && !failed ? "text-primary" : failed ? "text-destructive" : "text-muted-foreground"}`}>
          {!approval.decision ? (
            <>
              <Spinner className="size-3" /> Waiting for your OK
            </>
          ) : (
            <>
              {allowed && !failed ? <CheckIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
              {failed ? "Allowed, but it failed" : `${DONE[approval.decision]}${approval.result?.ok ? ", done" : ""}`}
            </>
          )}
        </span>
        <ChevronRightIcon className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t px-3 py-2.5">
          <div className="text-xs text-muted-foreground">{approval.appName}</div>
          {failed && approval.result?.text && <div className="text-xs break-words text-destructive">{approval.result.text}</div>}
          <Fields approval={approval} />
        </div>
      )}
    </div>
  );
}

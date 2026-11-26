"use client";

// Today: what needs a look across every client, today and this week: tasks late, due today or waiting on someone,
// processes whose step is stuck or due, projects due within a week, and what's due later this week. Each opens where
// it's dealt with. Everything else is done or on track.
import type { ProcessRun, Task } from "@emplio/shared";
import { ArrowUpIcon, CheckIcon, FolderKanbanIcon, PaperclipIcon, ListTodoIcon, MessageCircleIcon, WorkflowIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { PromptInput, PromptInputButton, PromptInputHeader, PromptInputSubmit, PromptInputTextarea } from "@/components/ai-elements/prompt-input";
import { AttachmentTray, SAY_FILES, SAY_TEXT, useAttachments } from "@/components/chat/attachments";
import { VoiceInput } from "@/components/chat/voice-input";
import { Monogram } from "@/components/clients/clients-page";
import { TaskPanel } from "@/components/tasks/tasks-page";
import { Due, Row, Section, ThingSheet, thingHref } from "@/components/things/things";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { useConversations, useMe, useProcessRuns, useTasks, useThings } from "@/lib/api";
import { cn } from "@/lib/utils";
import { daysAway, dayText, exactDate } from "@/lib/when";

const FEW = 6;
const open = (t: Task) => t.status === "todo" || t.status === "doing" || t.status === "waiting";
const byDue = (a: { dueAt: string | null }, b: { dueAt: string | null }) => (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~");
const Tile = ({ icon: Icon }: { icon: typeof ListTodoIcon }) => (
  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
    <Icon className="size-4 text-muted-foreground" />
  </span>
);

export function TodayPage() {
  const { data: me } = useMe();
  const tasks = useTasks();
  const runs = useProcessRuns();
  const things = useThings();
  const { data: conversations } = useConversations();
  const main = conversations?.find((c) => c.kind === "main");
  const [taskId, setTaskId] = useState<string | null>(null);

  // a process's steps are its run's, below: not listed twice
  const mine = (tasks.data ?? []).filter((t) => open(t) && !t.process);
  const days = (t: { dueAt: string | null }) => (t.dueAt ? daysAway(t.dueAt) : Infinity);
  const late = mine.filter((t) => t.status !== "waiting" && days(t) < 0).sort(byDue);
  const today = mine.filter((t) => t.status !== "waiting" && days(t) === 0);
  const waiting = mine.filter((t) => t.status === "waiting").sort(byDue);
  const week = mine.filter((t) => t.status !== "waiting" && days(t) > 0 && days(t) < 7).sort(byDue);
  const stuck = (runs.data ?? []).filter((r) => r.current && (r.current.status === "waiting" || days(r.current) < 7)).sort((a, b) => byDue(a.current!, b.current!));
  const projects = (things.data ?? [])
    .filter((p) => p.kind === "projects" && p.fields.due && daysAway(p.fields.due) <= 7 && !/^(done|complete|completed|closed|finished|cancell?ed)$/i.test(p.fields.status ?? ""))
    .sort((a, b) => a.fields.due!.localeCompare(b.fields.due!));
  const titles = new Map((things.data ?? []).map((t) => [t.path, t.title]));
  const loading = tasks.isPending || runs.isPending || things.isPending;
  const nothing = !late.length && !today.length && !waiting.length && !week.length && !stuck.length && !projects.length;

  const hour = new Date().getHours();
  const hello = `Good ${hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"}, ${me?.user.name?.split(" ")[0] ?? "there"}`;
  const summary = [late.length && `${late.length} late`, today.length && `${today.length} due today`, waiting.length && `${waiting.length} waiting on others`].filter(Boolean).join(", ");

  const taskRow = (t: Task, right: React.ReactNode) => (
    <li key={t.id}>
      <Row
        onClick={() => setTaskId(t.id)}
        lead={t.client ? <Monogram c={{ slug: t.client, name: t.clientName ?? t.client }} size="sm" /> : <Tile icon={ListTodoIcon} />}
        title={t.title}
        meta={[t.clientName, t.waitingOn ? `Waiting on ${t.waitingOn}` : t.assigneeId ? t.assigneeName : (t.agentName ?? "Emplio")].filter(Boolean).join(" · ")}
        right={right}
      />
    </li>
  );
  // late on our side in red; late on someone else's (waiting) in the app's waiting amber
  const when = (t: { dueAt: string | null }, tone?: "late" | "overdue" | "soft") =>
    t.dueAt ? (
      <span title={exactDate(t.dueAt)} className={cn(tone === "late" ? "font-medium text-destructive" : tone === "overdue" ? "font-medium text-amber-700 dark:text-amber-300" : tone === "soft" ? "text-muted-foreground" : "text-foreground")}>
        {dayText(t.dueAt, { late: tone === "late" || tone === "overdue" })}
      </span>
    ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <span className="px-2 font-sans text-sm font-medium tracking-normal">Today</span>
      </header>
      <div className="under-tabs min-h-0 flex-1 overflow-y-auto">
        {/* at least the page's height, so the message box sits at the foot even when there's little above it */}
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-7 px-4 pt-5 sm:pt-8 [&>*]:min-w-0">
          <div className="grid gap-1">
            <h1 className="font-heading text-xl font-semibold tracking-tight">{hello}</h1>
            <p className="text-sm text-muted-foreground">
              {new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
              {!loading && (summary ? ` · ${summary}` : nothing ? " · Nothing needs you" : "")}
            </p>
          </div>

          {loading ? (
            <div className="grid gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-xl" />
              ))}
            </div>
          ) : nothing ? (
            <div className="grid justify-items-center gap-2 rounded-2xl border border-dashed px-6 py-14 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-muted">
                <CheckIcon className="size-5 text-muted-foreground" />
              </span>
              <p className="text-sm font-medium">You&rsquo;re all caught up</p>
              <p className="max-w-sm text-sm text-pretty text-muted-foreground">Nothing is late, due or waiting this week. Give Emplio the next thing to do.</p>
              <Button size="sm" className="mt-2" nativeButton={false} render={<Link href={main ? `/chat/${main.id}` : "/home"} />}>
                <MessageCircleIcon />
                Open chat
              </Button>
            </div>
          ) : (
            <>
              <Few title="Late" list={late} row={(t) => taskRow(t, when(t, "late"))} />
              <Few title="Due today" list={today} row={(t) => taskRow(t, null)} />
              <Few title="Waiting on others" list={waiting} row={(t) => taskRow(t, when(t, t.dueAt && days(t) < 0 ? "overdue" : "soft"))} />
              <Few title="Processes" list={stuck} row={(r) => <RunRow key={r.id} r={r} onOpen={() => setTaskId(r.current!.taskId)} />} />
              <Few
                title="Projects due soon"
                list={projects}
                row={(p) => {
                  const client = /\[\[(clients\/[a-z0-9-]+)\]\]/.exec(p.fields.client ?? "")?.[1];
                  return (
                    <li key={p.path}>
                      <Row
                        href={thingHref(p.path) ?? undefined}
                        lead={client ? <Monogram c={{ slug: client.slice(8), name: titles.get(client) ?? client.slice(8) }} size="sm" /> : <Tile icon={FolderKanbanIcon} />}
                        title={p.title}
                        meta={client && titles.get(client)}
                        right={<Due due={p.fields.due} />}
                      />
                    </li>
                  );
                }}
              />
              <Few title="Later this week" list={week} row={(t) => taskRow(t, when(t, "soft"))} />
            </>
          )}
          <Ask chat={main ? `/chat/${main.id}` : "/chat"} />
        </div>
      </div>
      <Sheet open={!!taskId} onOpenChange={(o) => !o && setTaskId(null)}>
        <SheetContent className="w-full gap-0 overflow-x-hidden sm:max-w-md">{taskId && <TaskPanel id={taskId} onRemoved={() => setTaskId(null)} />}</SheetContent>
      </Sheet>
      {/* a project opened here (?open=projects/x) */}
      <ThingSheet />
    </div>
  );
}

// A section with its first few, the rest a tap away; nothing at all when empty.
function Few<T>({ title, list, row }: { title: string; list: T[]; row: (x: T) => React.ReactNode }) {
  const [all, setAll] = useState(false);
  if (!list.length) return null;
  return (
    <Section title={title} count={list.length}>
      {(all ? list : list.slice(0, FEW)).map(row)}
      {list.length > FEW && (
        <li>
          <Button variant="ghost" size="sm" className="ml-1 text-muted-foreground" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show ${list.length - FEW} more`}
          </Button>
        </li>
      )}
    </Section>
  );
}

// a process's go: where it is (the step bar, as on a client's panel), and its step's state
function RunRow({ r, onOpen }: { r: ProcessRun; onOpen: () => void }) {
  const c = r.current!;
  const late = c.dueAt && daysAway(c.dueAt) < 0;
  return (
    <li>
      <Row
        onClick={onOpen}
        lead={r.client ? <Monogram c={{ slug: r.client, name: r.subject }} size="sm" /> : <Tile icon={WorkflowIcon} />}
        title={
          <>
            {r.processTitle}
            <span className="font-normal text-muted-foreground"> · {r.subject}</span>
          </>
        }
        meta={
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex w-12 shrink-0 gap-0.5" aria-label={`Step ${r.step + 1} of ${r.steps.length}`}>
              {r.steps.map((_, i) => (
                <span key={i} className={cn("h-1 flex-1 rounded-full", i < r.step ? "bg-primary" : i === r.step ? (c.status === "waiting" ? "bg-amber-500" : "bg-primary/40") : "bg-muted-foreground/20")} />
              ))}
            </span>
            <span className="truncate">
              {r.steps[r.step]?.name} · {c.status === "waiting" ? `waiting${c.waitingOn ? ` on ${c.waitingOn}` : ""}` : c.assigneeName}
            </span>
          </span>
        }
        right={
          c.dueAt ? (
            <span title={exactDate(c.dueAt)} className={late ? "font-medium text-destructive" : "text-muted-foreground"}>
              {dayText(c.dueAt, { late: !!late })}
            </span>
          ) : null
        }
      />
    </li>
  );
}

// Emplio's message box, as the chat has it (same look, attach, voice, send), floating at the foot of the page: what's
// written goes into the main chat, which opens and sends it with the files (chat-view.tsx picks SAY_TEXT up).
// ponytail: no / commands or @ mentions here; they live in the chat's own box
function Ask({ chat }: { chat: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const attachments = useAttachments();
  const fileInput = useRef<HTMLInputElement>(null);
  const canSend = (!!text.trim() || attachments.ready) && !attachments.uploading;
  const send = () => {
    if (!canSend) return;
    try {
      sessionStorage.setItem(SAY_TEXT, text.trim() || "Here are some files.");
      sessionStorage.setItem(SAY_FILES, JSON.stringify(attachments.take()));
    } catch {}
    router.push(chat);
  };
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-auto bg-linear-to-t from-background from-70% to-transparent px-4 pt-6 pb-[max(0.75rem,var(--safe-bottom))] max-md:pb-3">
      <PromptInput
        onSubmit={() => send()}
        className="rounded-3xl shadow-sm transition-shadow focus-within:shadow-md [&_[data-slot=input-group]]:h-auto [&_[data-slot=input-group]]:flex-col [&_[data-slot=input-group]]:rounded-3xl [&_[data-slot=input-group]]:bg-card [&_[data-slot=input-group]]:ring-0! [&_[data-slot=input-group]]:focus-within:border-foreground/25"
      >
        {attachments.items.length > 0 && (
          <PromptInputHeader className="p-0">
            <AttachmentTray items={attachments.items} onRemove={attachments.remove} onRetry={attachments.retry} />
          </PromptInputHeader>
        )}
        <div className="flex w-full items-end">
          <div className="flex h-12 items-center pl-2" onMouseDown={(e) => e.preventDefault()}>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                attachments.add([...(e.currentTarget.files ?? [])]);
                e.currentTarget.value = "";
              }}
            />
            <PromptInputButton aria-label="Attach" onClick={() => fileInput.current?.click()} className="rounded-full text-muted-foreground">
              <PaperclipIcon className="size-4" />
            </PromptInputButton>
          </div>
          <div className="relative min-w-0 flex-1">
            <PromptInputTextarea
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (!files.length) return;
                e.preventDefault();
                attachments.add(files);
              }}
              placeholder="Ask Emplio anything…"
              className="min-h-0 px-2 py-3 text-[0.9rem] leading-6 placeholder:truncate"
            />
          </div>
          <div className="flex h-12 items-center gap-1 pr-2">
            <div className="flex" onMouseDown={(e) => e.preventDefault()}>
              <VoiceInput onText={(said) => setText((current) => [current.trim(), said].filter(Boolean).join(" "))} />
            </div>
            {/* not `disabled`: the input group fades itself out when anything inside is disabled */}
            <PromptInputSubmit aria-disabled={!canSend} aria-label="Send" className="size-8 rounded-full aria-disabled:opacity-40">
              <ArrowUpIcon className="size-4" />
            </PromptInputSubmit>
          </div>
        </div>
      </PromptInput>
    </div>
  );
}

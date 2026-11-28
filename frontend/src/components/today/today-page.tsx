"use client";

// Today: what needs a look across every client, today and this week: tasks late, due today or waiting on someone,
// processes whose step is stuck or due, projects due within a week, and what's due later this week. Each opens where
// it's dealt with. Everything else is done or on track.
import type { ProcessRun, Task } from "@emplio/shared";
import { CheckIcon, ListTodoIcon, MessageCircleIcon, WorkflowIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Monogram } from "@/components/clients/clients-page";
import { TaskPanel } from "@/components/tasks/tasks-page";
import { Due, RecordSheet, Row, Section } from "@/components/things/things";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { useConversations, useMe, useProcessRuns, useProjects, useTasks } from "@/lib/api";
import { cn } from "@/lib/utils";
import { daysAway, dayText, exactDate } from "@/lib/when";
import { AskFloat } from "@/components/chat/composer";

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
  const projectList = useProjects();
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
  // open ones (the list's default), due within a week or late
  const projects = (projectList.data ?? []).filter((p) => p.status === "active" && p.dueOn && daysAway(p.dueOn) <= 7).sort((a, b) => a.dueOn!.localeCompare(b.dueOn!));
  const loading = tasks.isPending || runs.isPending || projectList.isPending;
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
      <span title={exactDate(t.dueAt)} className={cn(tone === "late" ? "font-medium text-destructive" : tone === "overdue" ? "font-medium text-warning" : tone === "soft" ? "text-muted-foreground" : "text-foreground")}>
        {dayText(t.dueAt, { late: tone === "late" || tone === "overdue" })}
      </span>
    ) : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <AskFloat />
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <span className="px-2 font-sans text-sm font-medium tracking-normal">Today</span>
      </header>
      <div className="under-tabs flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pt-5 sm:pt-8 [&>*]:min-w-0">
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
            <div className="grid justify-items-center gap-2 rounded-xl border border-dashed px-6 py-14 text-center">
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
                row={(p) => (
                  <li key={p.id}>
                    <Row
                      href={`?open=${encodeURIComponent(`projects/${p.slug}`)}`}
                      lead={<Monogram c={p.client} size="sm" />}
                      title={p.name}
                      meta={[p.client.name, p.lead && `${p.lead.name} leads`].filter(Boolean).join(" · ")}
                      right={<Due due={p.dueOn!} />}
                    />
                  </li>
                )}
              />
              <Few title="Later this week" list={week} row={(t) => taskRow(t, when(t, "soft"))} />
            </>
          )}
        </div>
      </div>
      <Sheet open={!!taskId} onOpenChange={(o) => !o && setTaskId(null)}>
        <SheetContent className="w-full gap-0 overflow-x-hidden sm:max-w-md">{taskId && <TaskPanel id={taskId} onRemoved={() => setTaskId(null)} />}</SheetContent>
      </Sheet>
      {/* a project opened here (?open=projects/x) */}
      <RecordSheet />
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
                <span key={i} className={cn("h-1 flex-1 rounded-full", i < r.step ? "bg-primary" : i === r.step ? (c.status === "waiting" ? "bg-warning" : "bg-primary/40") : "bg-muted-foreground/20")} />
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

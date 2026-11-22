"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Process, ProcessRun, ProcessStep } from "@emplio/shared";
import { ChevronRightIcon, CircleDotIcon, FileTextIcon, HourglassIcon, MoreHorizontalIcon, PlayIcon, RouteIcon, SquareIcon, WorkflowIcon } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ClientPicker } from "@/components/clients/client-picker";
import { TaskSheet } from "@/components/tasks/tasks-page";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { api, processesQueryKey, processRunsQueryKey, recordsQueryKey, tasksQueryKey, useClients, useMe, useProcesses, useProcessRuns, useRecords } from "@/lib/api";
import { cn } from "@/lib/utils";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// How a process starts, in plain words.
export function startsWords(p: Pick<Process, "starts" | "every" | "clients">) {
  if (p.starts === "new client") return "For each new client";
  if (p.starts === "manual") return "Started when needed";
  const [, , dom, mon, dow] = (p.every ?? "").trim().split(/\s+/);
  const when =
    /^\d+$/.test(dom ?? "") && /^\d+$/.test(mon ?? "")
      ? `Every year on ${dom} ${MONTHS[+mon! - 1]}`
      : /^\d+$/.test(dom ?? "") && mon === "*"
        ? `Every month on day ${dom}`
        : /^[0-6]$/.test(dow ?? "") && dom === "*"
          ? `Every ${DAYS[+dow!]}`
          : "On a schedule";
  const n = p.clients?.includes("*") ? "every active client" : `${p.clients?.length ?? 0} client${p.clients?.length === 1 ? "" : "s"}`;
  return `${when}, for ${n}`;
}

const WHO: Record<string, string> = { handler: "Their handler", owner: "Owner", emplio: "Emplio", client: "The client" };
export const whoWords = (s: Pick<ProcessStep, "who">) => WHO[s.who.toLowerCase()] ?? s.who;
const short = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const late = (iso: string | null) => !!iso && new Date(iso) < new Date();

export function ProcessesPage() {
  const processes = useProcesses();
  const list = processes.data ?? [];
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <h1 className="px-2 font-sans text-sm font-medium tracking-normal">Processes</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {processes.isPending ? (
          <div className="mx-auto grid max-w-3xl gap-2 px-4 py-6 md:px-6">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : !list.length ? (
          <Empty />
        ) : (
          <ul className="mx-auto grid max-w-3xl gap-2 px-4 py-6 md:px-6">
            {list.map((p) => (
              <li key={p.name}>
                <Link
                  href={`/processes/${encodeURIComponent(p.name)}`}
                  className="flex items-center gap-4 rounded-xl border bg-card px-4 py-3.5 transition-colors hover:bg-muted/40"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                    <WorkflowIcon className="size-4" />
                  </span>
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate font-medium">{p.title}</span>
                    <span className={cn("truncate text-sm text-muted-foreground", p.error && "text-destructive")}>
                      {p.error ? "Needs fixing" : `${p.steps.length} steps · ${startsWords(p)}`}
                    </span>
                  </span>
                  {p.active > 0 && (
                    <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary tabular-nums">{p.active} going</span>
                  )}
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// One process: its runs and its steps.
export function ProcessPage() {
  const { name } = useParams<{ name: string }>();
  const { data: me } = useMe();
  const admin = me?.workspaces[0]?.role !== "member";
  const processes = useProcesses();
  const p = processes.data?.find((x) => x.name === decodeURIComponent(name));
  const [all, setAll] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 px-2 text-sm">
          <Link href="/processes" className="text-muted-foreground hover:text-foreground">
            Processes
          </Link>
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{p?.title ?? ""}</span>
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
          {processes.isPending ? (
            <div className="grid gap-3">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : !p ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              This process isn&rsquo;t there any more.{" "}
              <Link href="/processes" className="text-foreground underline underline-offset-4">
                See all processes
              </Link>
            </p>
          ) : (
            <Board p={p} all={all} setAll={setAll} admin={admin} onOpenTask={setTaskId} />
          )}
        </div>
      </div>
      <TaskSheet id={taskId} onClose={() => setTaskId(null)} />
    </div>
  );
}

function Empty() {
  return (
    <div className="mx-auto grid max-w-md justify-items-center gap-3 px-6 py-24 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
        <WorkflowIcon className="size-6" />
      </span>
      <h2 className="text-lg font-semibold">No processes yet</h2>
      <p className="text-sm text-muted-foreground">
        A process is work done the same steps every time: onboarding a client, a yearly filing, hiring for a role. Each step goes to the right person
        when the one before it is done, and you see where every client stands.
      </p>
      <p className="text-sm text-muted-foreground">
        Tell Emplio how you do one, like <span className="text-foreground">&ldquo;Set up our client onboarding: kick-off call, contract, advance, then setup&rdquo;</span>. It also writes them
        itself when it sees the same steps done again and again.
      </p>
    </div>
  );
}

function Board({ p, all, setAll, admin, onOpenTask }: { p: Process; all: boolean; setAll: (v: boolean) => void; admin: boolean; onOpenTask: (id: string) => void }) {
  const runs = useProcessRuns({ process: p.name, all });
  const queryClient = useQueryClient();
  const stop = useMutation({
    mutationFn: (id: string) => api(`/process-runs/${id}/stop`, {}),
    onSuccess: () => toast.success("Stopped"),
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: processRunsQueryKey });
      void queryClient.invalidateQueries({ queryKey: processesQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    },
  });
  const rows = runs.data ?? [];
  return (
    <section className="grid min-w-0 content-start gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 className="text-2xl font-semibold tracking-tight text-balance">{p.title}</h2>
          <p className="text-sm text-muted-foreground">
            {p.steps.length} steps · {startsWords(p)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {admin && (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link href={`/knowledge?file=${encodeURIComponent(`company/processes/${p.name}.md`)}`} />}
            >
              <FileTextIcon />
              Edit steps
            </Button>
          )}
          {!p.error && <Start p={p} />}
        </div>
      </div>
      {p.error && <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">This process can&rsquo;t run: {p.error}</p>}
      {p.about && <p className="max-w-prose text-sm whitespace-pre-line text-muted-foreground">{p.about}</p>}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 content-start gap-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">{all ? "All runs" : "Going now"}</h3>
            <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5 text-xs">
              {[
                { v: false, label: "Going" },
                { v: true, label: "All" },
              ].map((o) => (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => setAll(o.v)}
                  className={cn("rounded-md px-2.5 py-1 text-muted-foreground transition-colors", all === o.v && "bg-background font-medium text-foreground shadow-sm")}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          {runs.isPending ? (
            <div className="grid gap-2">
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
            </div>
          ) : !rows.length ? (
            <div className="grid justify-items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
              <RouteIcon className="size-5 text-muted-foreground" />
              <p className="text-sm font-medium">{all ? "Never run yet" : "Nothing going right now"}</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                {p.error
                  ? "Fix the process first."
                  : p.for === "client"
                    ? `Start it for a client and each step goes to the right person in turn.`
                    : p.for === "other"
                      ? "Start it for a candidate, a project or whatever it's for."
                      : `Start it for a ${p.for} and each step goes to the right person in turn.`}
              </p>
            </div>
          ) : (
            <ul className="grid gap-2">
              {rows.map((r) => (
                <RunCard key={r.id} r={r} onOpenTask={onOpenTask} onStop={admin && r.status === "active" ? () => stop.mutate(r.id) : undefined} />
              ))}
            </ul>
          )}
        </div>

        <aside className="grid content-start gap-3">
          <h3 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">Steps</h3>
          <ol className="grid">
            {p.steps.map((s, i) => (
              <li key={i} className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0">
                {i < p.steps.length - 1 && <span aria-hidden className="absolute top-7 bottom-1 left-3 w-px -translate-x-1/2 bg-border" />}
                <span className="grid size-6 place-items-center rounded-full border bg-background text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <div className="grid min-w-0 gap-0.5 pt-0.5">
                  <span className="text-sm leading-snug font-medium">{s.name}</span>
                  <span className="text-xs text-muted-foreground">{stepMeta(s, p.steps)}</span>
                  {s.how && <span className="line-clamp-2 text-xs text-muted-foreground/80">{s.how}</span>}
                </div>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </section>
  );
}

// "Owner · 2 days · can send back to step 2"
function stepMeta(s: ProcessStep, steps: ProcessStep[]) {
  const parts = [whoWords(s)];
  if (s.days)
    parts.push(
      `${s.days} day${s.days === 1 ? "" : "s"}${s.after === "start" ? " from the start" : typeof s.after === "number" ? ` after \u201c${steps[s.after - 1]?.name ?? `step ${s.after}`}\u201d` : ""}`,
    );
  if (s.back) parts.push(`can send back to step ${s.back}`);
  return parts.join(" · ");
}

function RunCard({ r, onOpenTask, onStop }: { r: ProcessRun; onOpenTask: (id: string) => void; onStop?: () => void }) {
  const active = r.status === "active";
  const cur = active ? r.current : null;
  const waiting = cur?.status === "waiting";
  const overdue = !!cur && late(cur.dueAt);
  const step = r.steps[r.step];
  return (
    <li className={cn("group relative rounded-xl border bg-card transition-colors hover:bg-muted/40", r.status === "stopped" && "opacity-60")}>
      <button type="button" disabled={!cur} onClick={() => cur && onOpenTask(cur.taskId)} className="grid w-full gap-2.5 px-4 py-3 pr-12 text-left disabled:cursor-default">
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate font-medium">
            {r.subject}
            {r.period && <span className="font-normal text-muted-foreground"> · {r.period}</span>}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {r.status === "done" ? `Done ${short(r.doneAt!)}` : r.status === "stopped" ? "Stopped" : `${r.step + 1} of ${r.steps.length}`}
          </span>
        </span>
        <span className="flex gap-1" aria-hidden>
          {r.steps.map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 flex-1 rounded-full",
                r.status === "done" || i < r.step
                  ? "bg-primary"
                  : i === r.step && active
                    ? waiting
                      ? "bg-amber-500"
                      : overdue
                        ? "bg-destructive"
                        : "bg-primary/35"
                    : "bg-muted",
              )}
            />
          ))}
        </span>
        {cur && step && (
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            {waiting ? <HourglassIcon className="size-3 text-amber-600" /> : <CircleDotIcon className="size-3 text-primary" />}
            <span className="min-w-0 truncate text-foreground">{step.name}</span>
            <span>· {waiting ? "waiting on them" : cur.assigneeName}</span>
            {cur.dueAt && <span className={cn(overdue && "font-medium text-destructive")}>· {overdue ? "late, was due" : "due"} {short(cur.dueAt)}</span>}
          </span>
        )}
      </button>
      {onStop && (
        <div className="absolute top-2 right-2">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${r.subject}`} />}>
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={onStop}>
                <SquareIcon />
                Stop this one
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </li>
  );
}

// Start one: for a client (picked), or for anything else (typed).
export function Start({ p, clientId, size = "sm" }: { p: Process; clientId?: string; size?: "sm" | "default" }) {
  const clients = useClients();
  const records = useRecords({ kind: p.for === "client" || p.for === "other" ? "-" : p.for });
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [client, setClient] = useState(clientId ?? "");
  const [subject, setSubject] = useState("");
  const start = useMutation({
    mutationFn: () => api<ProcessRun>("/process-runs", { process: p.name, clientId: p.for === "client" ? client : null, subject }),
    onSuccess: (r) => {
      toast.success(`Started for ${r.subject}`, { description: r.current ? `${r.steps[0]!.name}: ${r.current.assigneeName}` : undefined });
      setOpen(false);
      setSubject("");
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: processRunsQueryKey });
      void queryClient.invalidateQueries({ queryKey: processesQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: recordsQueryKey });
    },
  });
  const ready = p.for === "client" ? !!client : !!subject.trim();
  if (clientId)
    return (
      <Button size={size} variant="outline" disabled={start.isPending} onClick={() => start.mutate()}>
        <PlayIcon />
        Start
      </Button>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size={size} />}>
        <PlayIcon />
        Start
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>Start {p.title}</PopoverTitle>
          <PopoverDescription>Step 1, {p.steps[0]?.name}, goes to {whoWords(p.steps[0]!) === "Emplio" ? "Emplio" : whoWords(p.steps[0]!).toLowerCase()} now.</PopoverDescription>
        </PopoverHeader>
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) start.mutate();
          }}
        >
          {p.for === "client" ? (
            <ClientPicker
              items={[{ value: "", label: "Pick a client" }, ...(clients.data ?? []).filter((c) => c.stage !== "past").map((c) => ({ value: c.id, label: c.name }))]}
              value={client}
              onChange={setClient}
              className="w-full"
            />
          ) : p.for === "other" ? (
            <Input autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Who or what it's for, e.g. Sarah Lee, designer" />
          ) : (
            <>
              <Input autoFocus list={`records-${p.name}`} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={`Pick or type a new ${p.for}`} />
              <datalist id={`records-${p.name}`}>
                {(records.data ?? []).map((r) => (
                  <option key={r.id} value={r.title}>
                    {r.clientName ?? r.status}
                  </option>
                ))}
              </datalist>
            </>
          )}
          <Button type="submit" disabled={!ready || start.isPending}>
            <RouteIcon />
            Start
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

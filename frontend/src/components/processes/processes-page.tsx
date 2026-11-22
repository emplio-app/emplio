"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Process, ProcessRun, ProcessStep } from "@emplio/shared";
import { CheckIcon, FileTextIcon, HourglassIcon, MoreHorizontalIcon, PlayIcon, RouteIcon, SquareIcon, WorkflowIcon } from "lucide-react";
import Link from "next/link";
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
import { api, processesQueryKey, processRunsQueryKey, tasksQueryKey, useClients, useMe, useProcesses, useProcessRuns } from "@/lib/api";
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
  const { data: me } = useMe();
  const admin = me?.workspaces[0]?.role !== "member";
  const processes = useProcesses();
  const [picked, setPicked] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const list = processes.data ?? [];
  const current = list.find((p) => p.name === picked) ?? list[0] ?? null;
  const [taskId, setTaskId] = useState<string | null>(null);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <h1 className="px-2 font-sans text-sm font-medium tracking-normal">Processes</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {processes.isPending ? (
          <div className="mx-auto grid max-w-5xl gap-3 p-6">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : !list.length ? (
          <Empty />
        ) : (
          <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 md:grid-cols-[15rem_minmax(0,1fr)] md:px-6">
            <nav aria-label="Processes" className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
              {list.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => setPicked(p.name)}
                  className={cn(
                    "grid shrink-0 gap-0.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/60",
                    current?.name === p.name && "bg-muted",
                  )}
                >
                  <span className="flex items-center justify-between gap-3 text-sm font-medium">
                    <span className="truncate">{p.title}</span>
                    {p.active > 0 && <span className="rounded-full bg-primary/10 px-1.5 text-xs font-medium text-primary tabular-nums">{p.active}</span>}
                  </span>
                  <span className={cn("truncate text-xs text-muted-foreground", p.error && "text-destructive")}>
                    {p.error ? "Needs fixing" : `${p.steps.length} steps · ${startsWords(p)}`}
                  </span>
                </button>
              ))}
            </nav>
            {current && <Board key={current.name} p={current} all={all} setAll={setAll} admin={admin} onOpenTask={setTaskId} />}
          </div>
        )}
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
    <section className="grid min-w-0 content-start gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-2xl font-semibold tracking-tight">{p.title}</h2>
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

      <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5 text-sm self-start justify-self-start">
        {[
          { v: false, label: "Going" },
          { v: true, label: "All" },
        ].map((o) => (
          <button
            key={o.label}
            type="button"
            onClick={() => setAll(o.v)}
            className={cn("rounded-md px-3 py-1 text-muted-foreground", all === o.v && "bg-background font-medium text-foreground shadow-sm")}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              <th className="sticky left-0 z-10 min-w-48 bg-muted/40 px-4 py-3 font-medium backdrop-blur">{p.for === "client" ? "Client" : "For"}</th>
              {p.steps.map((s, i) => (
                <th key={i} className="min-w-36 px-3 py-3 align-top font-normal">
                  <span className="grid gap-0.5">
                    <span className="text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                    <span className="font-medium leading-snug">{s.name}</span>
                    <span className="text-xs text-muted-foreground">{whoWords(s)}</span>
                  </span>
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {runs.isPending ? (
              <tr>
                <td colSpan={p.steps.length + 2} className="p-4">
                  <Skeleton className="h-10 w-full" />
                </td>
              </tr>
            ) : !rows.length ? (
              <tr>
                <td colSpan={p.steps.length + 2} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {all ? "Never run yet." : "Nothing going right now."} {!p.error && "Start one for a client with Start."}
                </td>
              </tr>
            ) : (
              rows.map((r) => <Row key={r.id} r={r} onOpenTask={onOpenTask} onStop={admin && r.status === "active" ? () => stop.mutate(r.id) : undefined} />)
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Row({ r, onOpenTask, onStop }: { r: ProcessRun; onOpenTask: (id: string) => void; onStop?: () => void }) {
  const done = r.status === "done";
  return (
    <tr className={cn("border-b last:border-b-0", r.status === "stopped" && "opacity-55")}>
      <td className="sticky left-0 z-10 bg-background px-4 py-3 align-top">
        <span className="grid gap-1">
          <span className="font-medium">{r.subject}</span>
          <span className="text-xs text-muted-foreground">
            {[r.period, done ? `Done ${short(r.doneAt!)}` : r.status === "stopped" ? "Stopped" : `Step ${r.step + 1} of ${r.steps.length}`].filter(Boolean).join(" · ")}
          </span>
          <span className="mt-0.5 h-1 w-24 overflow-hidden rounded-full bg-muted">
            <span className={cn("block h-full rounded-full", done ? "bg-emerald-500" : "bg-primary")} style={{ width: `${(Math.min(r.step, r.steps.length) / r.steps.length) * 100}%` }} />
          </span>
        </span>
      </td>
      {r.steps.map((s, i) => (
        <td key={i} className="px-3 py-3 align-top">
          {s.finishedAt && i < r.step ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="grid size-4 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <CheckIcon className="size-3" />
              </span>
              {short(s.finishedAt)}
            </span>
          ) : i === r.step && r.status === "active" && r.current ? (
            <button
              type="button"
              onClick={() => onOpenTask(r.current!.taskId)}
              className={cn(
                "grid w-full gap-0.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/60",
                r.current.status === "waiting"
                  ? "border-amber-500/40 bg-amber-500/8"
                  : late(r.current.dueAt)
                    ? "border-destructive/40 bg-destructive/5"
                    : "border-primary/30 bg-primary/5",
              )}
            >
              <span className="flex items-center gap-1 font-medium text-foreground">
                {r.current.status === "waiting" && <HourglassIcon className="size-3 text-amber-600" />}
                <span className="truncate">{r.current.status === "waiting" ? "Waiting" : r.current.status === "doing" ? "In progress" : "To do"}</span>
              </span>
              <span className="truncate text-muted-foreground">{r.current.assigneeName}</span>
              {r.current.dueAt && <span className={cn("text-muted-foreground", late(r.current.dueAt) && "font-medium text-destructive")}>Due {short(r.current.dueAt)}</span>}
            </button>
          ) : (
            <span className="mt-1.5 block size-1.5 rounded-full bg-muted-foreground/25" />
          )}
        </td>
      ))}
      <td className="px-2 py-3 align-top">
        {onStop && (
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
        )}
      </td>
    </tr>
  );
}

// Start one: for a client (picked), or for anything else (typed).
export function Start({ p, clientId, size = "sm" }: { p: Process; clientId?: string; size?: "sm" | "default" }) {
  const clients = useClients();
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
          <PopoverDescription>Step 1, {p.steps[0]?.name}, goes to {whoWords(p.steps[0]!).toLowerCase()} now.</PopoverDescription>
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
          ) : (
            <Input autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Who or what it's for, e.g. Sarah Lee, designer" />
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

"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Process, ProcessInput, ProcessRun, ProcessStep } from "@emplio/shared";
import { ChevronRightIcon, CircleDotIcon, FileTextIcon, HourglassIcon, MoreHorizontalIcon, PencilIcon, PlayIcon, RepeatIcon, RouteIcon, SquareIcon, WorkflowIcon } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ClientPicker } from "@/components/clients/client-picker";
import { TaskSheet } from "@/components/tasks/tasks-page";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { api, processesQueryKey, processRunsQueryKey, tasksQueryKey, useClients, useMe, useProcesses, useProcessRuns } from "@/lib/api";
import { runDetails, runName } from "@/lib/process-inputs";
import { cn } from "@/lib/utils";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// How a process starts, in plain words: the automations that start it, or by hand.
export function startsWords(p: Pick<Process, "startedBy">) {
  if (!p.startedBy.length) return "Started when needed";
  return p.startedBy.map(oneStart).join("; ");
}
function oneStart(a: Process["startedBy"][number]) {
  if (a.when === "new client") return "For each new client";
  if (a.when !== "schedule") return a.when === "trigger" ? "When something happens in an app" : "When run by hand";
  const [, , dom, mon, dow] = (a.schedule ?? "").trim().split(/\s+/);
  const when =
    /^\d+$/.test(dom ?? "") && /^\d+$/.test(mon ?? "")
      ? `Every year on ${dom} ${MONTHS[+mon! - 1]}`
      : /^\d+$/.test(dom ?? "") && mon === "*"
        ? `Every month on day ${dom}`
        : /^[0-6]$/.test(dow ?? "") && dom === "*"
          ? `Every ${DAYS[+dow!]}`
          : "On a schedule";
  const one = a.clients?.length === 1 && a.clients[0]!.includes("=") ? `clients with ${a.clients[0]}` : null;
  const n = a.clients?.includes("*") ? "every active client" : (one ?? `${a.clients?.length ?? 0} client${a.clients?.length === 1 ? "" : "s"}`);
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
  const [editing, setEditing] = useState<ProcessRun | null>(null);
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
              render={<Link href={`/chat?file=${encodeURIComponent(`company/processes/${p.name}.md`)}`} />}
            >
              <FileTextIcon />
              Edit steps
            </Button>
          )}
          {admin && (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={
                <Link
                  href={
                    p.startedBy.length === 1
                      ? `/chat?file=${encodeURIComponent(`company/automations/${p.startedBy[0]!.name}.md`)}`
                      : `/chat?file=${encodeURIComponent(`company/processes/${p.name}.md`)}&do=repeat`
                  }
                />
              }
            >
              <RepeatIcon />
              {p.startedBy.length ? "Change when" : "Repeat"}
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
                    : "Start it for a candidate, a project or whatever it's for."}
              </p>
            </div>
          ) : (
            <ul className="grid gap-2">
              {rows.map((r) => (
                <RunCard key={r.id} r={r} onOpenTask={onOpenTask} onStop={admin && r.status === "active" ? () => stop.mutate(r.id) : undefined} onEdit={r.status === "active" && r.inputs.length ? () => setEditing(r) : undefined} />
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
                  <span className="text-xs text-muted-foreground">{stepMeta(s, p.steps, p.inputs)}</span>
                  {s.how && <span className="line-clamp-2 text-xs text-muted-foreground/80">{s.how}</span>}
                </div>
              </li>
            ))}
          </ol>
        </aside>
      </div>
      {editing && <EditDetails key={editing.id} r={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

// "Owner · 2 days · can send back to step 2", "Their handler · 7 days before Filing deadline"
function stepMeta(s: ProcessStep, steps: ProcessStep[], inputs: ProcessInput[]) {
  const parts = [whoWords(s)];
  const date = s.afterInput && inputs.find((x) => x.key === s.afterInput)?.name;
  if (s.days !== undefined && date)
    parts.push(s.days ? `${Math.abs(s.days)} day${Math.abs(s.days) === 1 ? "" : "s"} ${s.days < 0 ? "before" : "after"} ${date}` : `on ${date}`);
  else if (s.days)
    parts.push(
      `${s.days} day${s.days === 1 ? "" : "s"}${s.after === "start" ? " from the start" : typeof s.after === "number" ? ` after \u201c${steps[s.after - 1]?.name ?? `step ${s.after}`}\u201d` : ""}`,
    );
  if (s.back) parts.push(`can send back to step ${s.back}`);
  return parts.join(" · ");
}

function RunCard({ r, onOpenTask, onStop, onEdit }: { r: ProcessRun; onOpenTask: (id: string) => void; onStop?: () => void; onEdit?: () => void }) {
  const details = runDetails(r);
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
            {runName(r)}
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
        {details && <span className="truncate text-xs text-muted-foreground">{details}</span>}
        {cur && step && (
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
            {waiting ? <HourglassIcon className="size-3 text-amber-600" /> : <CircleDotIcon className="size-3 text-primary" />}
            <span className="min-w-0 truncate text-foreground">{step.name}</span>
            <span>· {waiting ? "waiting on them" : cur.assigneeName}</span>
            {cur.dueAt && <span className={cn(overdue && "font-medium text-destructive")}>· {overdue ? "late, was due" : "due"} {short(cur.dueAt)}</span>}
          </span>
        )}
      </button>
      {(onStop || onEdit) && (
        <div className="absolute top-2 right-2">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${runName(r)}`} />}>
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onEdit && (
                <DropdownMenuItem onClick={onEdit}>
                  <PencilIcon />
                  Edit details
                </DropdownMenuItem>
              )}
              {onStop && (
                <DropdownMenuItem variant="destructive" onClick={onStop}>
                  <SquareIcon />
                  Stop this one
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </li>
  );
}

// One field per input: a date box for a date, a dropdown for a choice, a number box for a number.
export function InputFields({ inputs, values, onChange }: { inputs: ProcessInput[]; values: Record<string, string>; onChange: (key: string, value: string) => void }) {
  return inputs.map((x) => (
    <div key={x.key} className="grid gap-1.5">
      <Label htmlFor={`input-${x.key}`} className="text-xs font-normal text-muted-foreground">
        {x.name}
        {!x.required && <span className="text-muted-foreground/70"> (optional)</span>}
      </Label>
      {x.type === "choice" ? (
        <Select
          items={[{ value: null, label: x.required ? "Pick one" : "None" }, ...x.options!.map((o) => ({ value: o, label: o }))]}
          value={values[x.key] || null}
          onValueChange={(v) => onChange(x.key, (v as string | null) ?? "")}
        >
          <SelectTrigger id={`input-${x.key}`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {!x.required && <SelectItem value={null}>None</SelectItem>}
            {x.options!.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={`input-${x.key}`}
          type={x.type === "date" ? "date" : "text"}
          inputMode={x.type === "number" ? "decimal" : undefined}
          value={values[x.key] ?? ""}
          onChange={(e) => onChange(x.key, e.target.value)}
        />
      )}
    </div>
  ));
}

const filled = (inputs: ProcessInput[], values: Record<string, string>) => inputs.every((x) => !x.required || values[x.key]?.trim());

// Starting one: the client (unless it's given), or what it's for, then its inputs.
export function StartForm({ p, clientId, onDone }: { p: Process; clientId?: string; onDone: () => void }) {
  const clients = useClients();
  const queryClient = useQueryClient();
  const [client, setClient] = useState(clientId ?? "");
  const [subject, setSubject] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const start = useMutation({
    mutationFn: () => api<ProcessRun>("/process-runs", { process: p.name, clientId: p.for === "client" ? client : null, subject, inputs: values }),
    onSuccess: (r) => {
      toast.success(`Started for ${runName(r)}`, { description: r.current ? `${r.steps[0]!.name}: ${r.current.assigneeName}` : undefined });
      onDone();
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: processRunsQueryKey });
      void queryClient.invalidateQueries({ queryKey: processesQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    },
  });
  // a process for other things with no inputs is named by hand; with some, by its first
  const named = p.for === "other" && !p.inputs.length;
  const ready = (p.for === "client" ? !!client : !named || !!subject.trim()) && filled(p.inputs, values);
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !start.isPending) start.mutate();
      }}
    >
      {p.for === "client" && !clientId && (
        <ClientPicker
          items={[{ value: "", label: "Pick a client" }, ...(clients.data ?? []).filter((c) => c.stage !== "past").map((c) => ({ value: c.id, label: c.name }))]}
          value={client}
          onChange={setClient}
          className="w-full"
        />
      )}
      {named && <Input autoFocus value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Who or what it's for, e.g. Sarah Lee, designer" />}
      <InputFields inputs={p.inputs} values={values} onChange={(k, v) => setValues((now) => ({ ...now, [k]: v }))} />
      <Button type="submit" disabled={!ready || start.isPending}>
        <RouteIcon />
        Start
      </Button>
    </form>
  );
}

// Start one, from the process's page.
function Start({ p }: { p: Process }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="sm" />}>
        <PlayIcon />
        Start
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>Start {p.title}</PopoverTitle>
          <PopoverDescription>Step 1, {p.steps[0]?.name}, goes to {whoWords(p.steps[0]!) === "Emplio" ? "Emplio" : whoWords(p.steps[0]!).toLowerCase()} now.</PopoverDescription>
        </PopoverHeader>
        {open && <StartForm p={p} onDone={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  );
}

// Change what was filled in when it started.
export function EditDetails({ r, onClose }: { r: ProcessRun; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(r.inputs.map((x) => [x.key, x.value ?? ""])));
  const changed = Object.fromEntries(r.inputs.filter((x) => (values[x.key] ?? "") !== (x.value ?? "")).map((x) => [x.key, values[x.key] ?? ""]));
  const save = useMutation({
    mutationFn: () => api<ProcessRun>(`/process-runs/${r.id}`, { inputs: changed }, "PATCH"),
    onSuccess: () => {
      toast.success("Saved");
      onClose();
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: processRunsQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{runName(r)}</DialogTitle>
          <DialogDescription>{r.processTitle}: what was filled in when it started.</DialogDescription>
        </DialogHeader>
        <form
          id={`details-${r.id}`}
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (Object.keys(changed).length && filled(r.inputs, values)) save.mutate();
          }}
        >
          <InputFields inputs={r.inputs} values={values} onChange={(k, v) => setValues((now) => ({ ...now, [k]: v }))} />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={`details-${r.id}`} disabled={!Object.keys(changed).length || !filled(r.inputs, values) || save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

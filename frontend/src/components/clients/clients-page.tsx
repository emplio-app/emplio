"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Client, ClientInput, ClientStage, Process, ProcessRun, Task, TeamMember } from "@emplio/shared";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRightIcon,
  Building2Icon,
  CalendarIcon,
  CheckIcon,
  FileTextIcon,
  HourglassIcon,
  ListTodoIcon,
  PlusIcon,
  SearchIcon,
  UserPlusIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { TaskPanel } from "@/components/tasks/tasks-page";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";
import { StartForm } from "@/components/processes/processes-page";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { api, clientsQueryKey, processesQueryKey, processRunsQueryKey, tasksQueryKey, useClients, useMe, useProcesses, useProcessRuns, useTasks, useThingPage } from "@/lib/api";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { inputText } from "@/lib/process-inputs";
import { cn } from "@/lib/utils";

const STAGES: { value: ClientStage; label: string; hint: string }[] = [
  { value: "active", label: "Active", hint: "Working with them now" },
  { value: "prospect", label: "Prospect", hint: "Not won yet" },
  { value: "past", label: "Past", hint: "No longer working together" },
];
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.value, s.label])) as Record<ClientStage, string>;
const FILTERS = [{ value: "all", label: "All" }, ...STAGES.map((s) => ({ value: s.value, label: s.label === "Prospect" ? "Prospects" : s.label }))];

const initials = (name: string) =>
  name
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";

// a steady colour per client, so the same client looks the same everywhere
const TINTS = [
  "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  "bg-teal-500/12 text-teal-700 dark:text-teal-300",
];
const tint = (slug: string) => TINTS[[...slug].reduce((n, c) => n + c.charCodeAt(0), 0) % TINTS.length]!;

const notesHref = (c: Client) => `/knowledge?file=${encodeURIComponent(`company/clients/${c.slug}.md`)}`;

function Monogram({ c, size = "md" }: { c: Pick<Client, "name" | "slug">; size?: "md" | "lg" }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-xl font-semibold",
        size === "lg" ? "size-12 text-base" : "size-10 text-sm",
        tint(c.slug),
      )}
      aria-hidden
    >
      {initials(c.name)}
    </span>
  );
}

function StagePill({ stage }: { stage: ClientStage }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.65rem] font-medium",
        stage === "active" && "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
        stage === "prospect" && "bg-blue-500/10 text-blue-700 dark:text-blue-300",
        stage === "past" && "bg-muted text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          stage === "active" && "bg-emerald-500",
          stage === "prospect" && "bg-blue-500",
          stage === "past" && "bg-muted-foreground/50",
        )}
      />
      {STAGE_LABEL[stage]}
    </span>
  );
}

function Handlers({ c }: { c: Client }) {
  if (!c.handlers.length)
    return <span className="text-xs text-muted-foreground/80 italic">Nobody named yet</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={c.handlers.map((h) => h.name).join(", ")}>
      <span className="flex -space-x-1.5">
        {c.handlers.slice(0, 3).map((h) => (
          <span
            key={h.id}
            className="grid size-5 place-items-center rounded-full bg-primary/10 text-[0.6rem] font-semibold text-primary ring-2 ring-background"
          >
            {initials(h.name)}
          </span>
        ))}
      </span>
      <span className="truncate">
        {c.handlers[0]!.name}
        {c.handlers.length > 1 && ` +${c.handlers.length - 1}`}
      </span>
    </span>
  );
}

// Who the business works for, read like a book of clients: who they are, how things stand, who looks after them and
// what's open for them. Emplio keeps it from chats and email; anyone can add one, owners and admins change them.
export function ClientsPage() {
  const [taskId, setTaskIdRaw] = useState<string | null>(null);
  // back from a task: the client's panel slides in from the left (opened fresh, it just appears with the sheet)
  const [cameBack, setCameBack] = useState(false);
  const setTaskId = (id: string | null) => {
    setCameBack(!id && !!taskId);
    setTaskIdRaw(id);
  };
  const { data: me } = useMe();
  const admin = me?.workspaces[0]?.role !== "member";
  const clients = useClients();
  const tasks = useTasks();
  const team = useQuery({ queryKey: ["team"], queryFn: () => api<TeamMember[]>("/team") });
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("active");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const update = useMutation({
    mutationFn: ({ id, ...body }: ClientInput & { id: string }) => api<Client>(`/clients/${id}`, body, "PATCH"),
    onMutate: ({ id, ...body }) =>
      queryClient.setQueryData<Client[]>(clientsQueryKey, (old) =>
        old?.map((c) =>
          c.id === id
            ? {
                ...c,
                ...(body.name !== undefined && { name: body.name }),
                ...(body.stage !== undefined && { stage: body.stage }),
                ...(body.handlerIds !== undefined && {
                  handlers: body.handlerIds.map((h) => {
                    const m = team.data?.find((t) => t.id === h);
                    return { id: h, name: m?.name ?? m?.email ?? "" };
                  }),
                }),
              }
            : c,
        ),
      ),
    onError: (e) => toast.error(e.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: clientsQueryKey }),
  });

  const all = clients.data ?? [];
  const counts = Object.fromEntries(FILTERS.map((f) => [f.value, f.value === "all" ? all.length : all.filter((c) => c.stage === f.value).length]));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all
    .filter((c) => (filter === "unhandled" ? c.stage === "active" && !c.handlers.length : filter === "all" || c.stage === filter))
    .filter((c) => words.every((w) => [c.name, ...c.handlers.map((h) => h.name)].join(" ").toLowerCase().includes(w)));
  const current = all.find((c) => c.id === openId) ?? null;
  const unhandled = all.filter((c) => c.stage === "active" && !c.handlers.length).length;
  const waiting = all.reduce((n, c) => n + c.waitingTasks, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <span className="px-2 font-sans text-sm font-medium tracking-normal">Clients</span>
      </header>

      <div className="under-tabs min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-5 px-4 py-5 sm:gap-6 sm:py-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="grid gap-1">
              <h1 className="font-heading text-xl font-semibold tracking-tight">Clients</h1>
              <p className="text-sm text-muted-foreground">
                {clients.isPending
                  ? "Loading…"
                  : all.length
                    ? [
                        `${counts.active} active`,
                        counts.prospect ? `${counts.prospect} prospect${counts.prospect === 1 ? "" : "s"}` : "",
                        waiting ? `${waiting} thing${waiting === 1 ? "" : "s"} waiting on clients` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "Who you work for, and who looks after each."}
              </p>
            </div>
            <Button size="sm" onClick={() => setAdding(true)}>
              <PlusIcon />
              Add client
            </Button>
          </div>

          {adding && <AddClient onDone={() => setAdding(false)} />}

          {admin && unhandled > 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3.5 py-3 text-sm">
              <UserPlusIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="min-w-0 flex-1 text-pretty">
                <span className="font-medium">
                  {unhandled} active client{unhandled === 1 ? " has" : "s have"} nobody looking after {unhandled === 1 ? "it" : "them"}.
                </span>{" "}
                <span className="text-muted-foreground">Pick who handles each, so their work and reminders go to the right person.</span>
              </p>
              {filter !== "unhandled" ? (
                <Button size="xs" variant="outline" className="shrink-0" onClick={() => setFilter("unhandled")}>
                  Show them
                </Button>
              ) : (
                <Button size="xs" variant="ghost" className="shrink-0" onClick={() => setFilter("active")}>
                  Show all
                </Button>
              )}
            </div>
          )}

          {all.length > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div role="tablist" aria-label="Stage" className="inline-flex shrink-0 rounded-lg bg-muted p-0.5">
                {FILTERS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    role="tab"
                    aria-selected={filter === f.value}
                    onClick={() => setFilter(f.value)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
                      filter === f.value && "bg-background text-foreground shadow-xs",
                    )}
                  >
                    {f.label}
                    <span className="tabular-nums opacity-60">{counts[f.value]}</span>
                  </button>
                ))}
              </div>
              <InputGroup className="h-8 flex-1">
                <InputGroupAddon>
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search clients or people" aria-label="Search clients" />
                {query && (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton size="icon-xs" onClick={() => setQuery("")} aria-label="Clear search">
                      <XIcon />
                    </InputGroupButton>
                  </InputGroupAddon>
                )}
              </InputGroup>
            </div>
          )}

          {clients.isPending ? (
            <div className="grid gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-xl" />
              ))}
            </div>
          ) : !all.length ? (
            <div className="grid justify-items-center gap-2 rounded-2xl border border-dashed px-6 py-14 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-muted">
                <Building2Icon className="size-5 text-muted-foreground" />
              </span>
              <p className="text-sm font-medium">No clients yet</p>
              <p className="max-w-sm text-sm text-pretty text-muted-foreground">
                Emplio adds them as they come up in chats and email. You can also add one, or just say
                &ldquo;Northwind is a new client, Sarah handles them&rdquo;.
              </p>
            </div>
          ) : !shown.length ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {words.length ? <>No clients match &ldquo;{query.trim()}&rdquo;.</> : "None here."}
            </p>
          ) : (
            <ul className="grid gap-1.5">
              {shown.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(c.id)}
                    className="group flex w-full items-center gap-3 rounded-xl border border-transparent px-2.5 py-2.5 text-left transition-colors hover:border-border hover:bg-muted/40 focus-visible:border-ring focus-visible:outline-none"
                  >
                    <Monogram c={c} />
                    <span className="grid min-w-0 flex-1 gap-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{c.name}</span>
                        {filter === "all" && <StagePill stage={c.stage} />}
                      </span>
                      <Handlers c={c} />
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1 text-xs tabular-nums">
                      {c.openTasks ? (
                        <span className="inline-flex items-center gap-1 text-foreground">
                          <ListTodoIcon className="size-3.5 text-muted-foreground" />
                          {c.openTasks} open
                        </span>
                      ) : (
                        <span className="text-muted-foreground/70">Nothing open</span>
                      )}
                      {c.waitingTasks > 0 && (
                        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                          <HourglassIcon className="size-3" />
                          {c.waitingTasks} waiting
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Sheet
        open={!!current}
        onOpenChange={(o) => {
          if (o) return;
          setOpenId(null);
          setTaskId(null);
        }}
      >
        <SheetContent className="w-full gap-0 overflow-x-hidden sm:max-w-md">
          {/* one panel: a task opened from the client's open work slides in over them, and back slides them back */}
          {current && taskId ? (
            <div key={taskId} className="flex min-h-0 flex-1 flex-col duration-200 ease-out animate-in fade-in-0 slide-in-from-right-8 motion-reduce:animate-none">
              <TaskPanel id={taskId} onRemoved={() => setTaskId(null)} back={{ label: current.name, onClick: () => setTaskId(null) }} />
            </div>
          ) : current ? (
            <div key={current.id} className={cn("flex min-h-0 flex-1 flex-col", cameBack && "duration-200 ease-out animate-in fade-in-0 slide-in-from-left-8 motion-reduce:animate-none")}>
              <ClientDetails
                key={current.id}
                c={current}
                known={[...new Set(all.flatMap((x) => x.details.map((d) => d.name)))]}
                admin={admin}
                team={team.data ?? []}
                tasks={(tasks.data ?? []).filter((t) => t.clientId === current.id)}
                onChange={(body) => update.mutate({ id: current.id, ...body })}
                onOpenTask={setTaskId}
              />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function AddClient({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [stage, setStage] = useState<ClientStage>("active");
  const add = useMutation({
    mutationFn: (body: ClientInput) => api<Client>("/clients", body),
    onSuccess: (c) => {
      queryClient.setQueryData<Client[]>(clientsQueryKey, (old) => [...(old ?? []), c].sort((a, b) => a.name.localeCompare(b.name)));
      void queryClient.invalidateQueries({ queryKey: clientsQueryKey });
      toast(`Added ${c.name}`);
      onDone();
    },
  });
  return (
    <form
      className="grid gap-2 rounded-xl border bg-background p-2 shadow-xs focus-within:ring-2 focus-within:ring-ring/30"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) add.mutate({ name, stage });
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onDone()}
        placeholder="Client name, e.g. Northwind Traders"
        aria-label="Client name"
        className="h-9 bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
      />
      <div className="flex items-center gap-2">
        <Select items={STAGES} value={stage} onValueChange={(v) => v && setStage(v as ClientStage)}>
          <SelectTrigger size="sm" aria-label="Stage" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STAGES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {add.error && <p className="min-w-0 truncate text-xs text-destructive">{add.error.message}</p>}
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!name.trim() || add.isPending}>
          Add
        </Button>
      </div>
    </form>
  );
}

function dueText(iso: string) {
  const d = new Date(iso);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

// Short facts kept on a client (Contact email, Tax number, Files: monthly): anyone may fill them in. Processes fill an
// input of the same name from them; Emplio adds them as it learns them. A detail any client has shows on every client,
// empty until filled in.
function ClientFacts({ c, known, onChange }: { c: Client; known: string[]; onChange: (details: Record<string, string | null>) => void }) {
  const has = new Set(c.details.map((d) => d.name.toLowerCase()));
  const rows = [...c.details, ...known.filter((n) => !has.has(n.toLowerCase())).map((name) => ({ name, value: "" }))];
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const add = () => {
    if (!name.trim() || !value.trim()) return;
    onChange({ [name.trim()]: value.trim() });
    setName("");
    setValue("");
  };
  return (
    <section className="grid gap-2">
      <h2 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">Details</h2>
      {rows.length > 0 && (
        <div className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-x-3 gap-y-1.5">
          {rows.map((d) => (
            <Fact key={`${d.name}:${d.value}`} name={d.name} value={d.value} onChange={(v) => onChange({ [d.name]: v })} />
          ))}
        </div>
      )}
      <form
        className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-x-3"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input aria-label="Detail" placeholder="Email" value={name} onChange={(e) => setName(e.target.value)} />
        <Input aria-label="Value" placeholder="sarah@northwind.com" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" variant="ghost" size="icon-sm" aria-label="Add detail" disabled={!name.trim() || !value.trim()}>
          <PlusIcon />
        </Button>
      </form>
    </section>
  );
}

function Fact({ name, value, onChange }: { name: string; value: string; onChange: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  return (
    <>
      <Label className="truncate text-muted-foreground" title={name}>
        {name}
      </Label>
      <Input
        aria-label={name}
        placeholder="Not set"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => (v.trim() ? v.trim() !== value && onChange(v.trim()) : setV(value))}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      {value ? (
        <Button variant="ghost" size="icon-sm" aria-label={`Remove ${name}`} onClick={() => onChange(null)}>
          <XIcon />
        </Button>
      ) : (
        <span />
      )}
    </>
  );
}

function ClientDetails({
  c,
  known,
  admin,
  team,
  tasks,
  onChange,
  onOpenTask,
}: {
  c: Client;
  known: string[];
  admin: boolean;
  team: TeamMember[];
  tasks: Task[];
  onChange: (body: ClientInput) => void;
  onOpenTask: (id: string) => void;
}) {
  const [name, setName] = useState(c.name);
  const open = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const handlerIds = c.handlers.map((h) => h.id);
  return (
    <>
      <SheetHeader className="gap-3 border-b pr-12">
        <div className="flex items-center gap-3">
          <Monogram c={c} size="lg" />
          <div className="grid min-w-0 gap-1">
            <SheetTitle className="sr-only">{c.name}</SheetTitle>
            {admin ? (
              <input
                aria-label="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() && name.trim() !== c.name && onChange({ name })}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                className="min-w-0 bg-transparent font-heading text-lg font-semibold outline-none"
              />
            ) : (
              <p className="truncate font-heading text-lg font-semibold">{c.name}</p>
            )}
            <SheetDescription className="flex items-center gap-2">
              <StagePill stage={c.stage} />
              {open.length ? `${open.length} open task${open.length === 1 ? "" : "s"}` : "Nothing open"}
            </SheetDescription>
          </div>
        </div>
      </SheetHeader>

      <div className="grid flex-1 content-start gap-6 overflow-y-auto p-4">
        <div className="grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-3">
          <Label className="text-muted-foreground">Stage</Label>
          <Select items={STAGES} value={c.stage} disabled={!admin} onValueChange={(v) => v && onChange({ stage: v as ClientStage })}>
            <SelectTrigger aria-label="Stage" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STAGES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  <span className="grid">
                    <span>{s.label}</span>
                    <span className="text-xs text-muted-foreground">{s.hint}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label className="text-muted-foreground">Handled by</Label>
          <HandlerPicker clientName={c.name} team={team} value={handlerIds} disabled={!admin} onChange={(ids) => onChange({ handlerIds: ids })} />
        </div>

        <ClientFacts key={c.id} c={c} known={known} onChange={(details) => onChange({ details })} />

        <ClientLinked slug={c.slug} />

        <ClientProcesses clientId={c.id} onOpenTask={onOpenTask} />

        <section className="grid gap-2">
          <div className="flex items-center justify-between">
            <h2 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">Open work</h2>
            {tasks.length > 0 && (
              <Link href={`/tasks?client=${c.id}`} className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground">
                All their tasks
                <ArrowUpRightIcon className="size-3" />
              </Link>
            )}
          </div>
          {open.length ? (
            <ul className="grid gap-1">
              {open.slice(0, 12).map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => onOpenTask(t.id)} className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-muted/50">
                    <span
                      className={cn(
                        "mt-1 size-2 shrink-0 rounded-full",
                        t.status === "waiting" ? "bg-amber-500" : t.status === "doing" ? "bg-blue-500" : "bg-muted-foreground/40",
                      )}
                    />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="text-sm">{t.title}</span>
                      <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                        <span>{t.assigneeId ? t.assigneeName : (t.agentName ?? "Emplio")}</span>
                        {t.waitingOn && <span className="text-amber-700 dark:text-amber-300">Waiting on {t.waitingOn}</span>}
                        {t.dueAt && (
                          <span className={cn("inline-flex items-center gap-1", new Date(t.dueAt) < new Date() && "font-medium text-destructive")}>
                            <CalendarIcon className="size-3" />
                            {dueText(t.dueAt)}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-3 text-sm text-muted-foreground">
              <CheckIcon className="size-4" />
              Nothing open for {c.name}.
            </p>
          )}
        </section>
      </div>

      <SheetFooter className="flex-row items-center border-t">
        <Button variant="outline" size="sm" nativeButton={false} render={<Link href={notesHref(c)} />}>
          <FileTextIcon />
          Notes
        </Button>
        <Button size="sm" className="ml-auto" nativeButton={false} render={<Link href={`/tasks?client=${c.id}`} />}>
          <ListTodoIcon />
          Their tasks
        </Button>
      </SheetFooter>
    </>
  );
}

// Who looks after a client: type to find someone, pick as many as handle them, remove with the x.
function HandlerPicker({ clientName, team, value, disabled, onChange }: { clientName: string; team: TeamMember[]; value: string[]; disabled: boolean; onChange: (ids: string[]) => void }) {
  const anchor = useComboboxAnchor();
  const chosen = team.filter((m) => value.includes(m.id));
  return (
    <Combobox
      multiple
      autoHighlight
      items={team}
      value={chosen}
      onValueChange={(next: TeamMember[]) => onChange(next.map((m) => m.id))}
      itemToStringLabel={(m: TeamMember) => `${m.name ?? ""} ${m.email}`}
      isItemEqualToValue={(a: TeamMember, b: TeamMember) => a.id === b.id}
      disabled={disabled}
    >
      <ComboboxChips ref={anchor} className="min-h-9 w-full">
        <ComboboxValue>
          {(picked: TeamMember[]) => (
            <>
              {picked.map((m) => (
                <ComboboxChip key={m.id}>{m.name ?? m.email}</ComboboxChip>
              ))}
              <ComboboxChipsInput placeholder={picked.length ? "Add someone" : `Who looks after ${clientName}?`} />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor} className="min-w-(--anchor-width)">
        <ComboboxEmpty>Nobody on the team matches.</ComboboxEmpty>
        <ComboboxList>
          {(m: TeamMember) => (
            <ComboboxItem key={m.id} value={m}>
              <span className="grid min-w-0">
                <span className="truncate">{m.name ?? m.email}</span>
                {m.name && <span className="truncate text-xs text-muted-foreground">{m.email}</span>}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

// The processes going for this client, the step each is on, and starting another.
// The files that name this client (company/contacts/, projects/): their people and their projects, each opening its file.
const LINKED = [
  { kind: "contacts", label: "Contacts", sub: (f: Record<string, string>) => [f.role, f.email] },
  { kind: "projects", label: "Projects", sub: (f: Record<string, string>) => [f.due ? `due ${f.due}` : f.start ? "ongoing" : "", f.fee] },
] as const;
const plain = (v?: string) => v?.replace(/\[\[[a-z]+\/([^\]]+)\]\]/g, "$1");

function ClientLinked({ slug }: { slug: string }) {
  const page = useThingPage(`clients/${slug}`);
  const from = page.data?.linkedFrom ?? [];
  return LINKED.map(({ kind, label, sub }) => {
    const items = from.filter((l) => l.kind === kind);
    if (!items.length) return null;
    return (
      <section key={kind} className="grid gap-2">
        <h2 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">{label}</h2>
        <ul className="grid gap-1">
          {items.map((l) => (
            <li key={l.from}>
              <Link href={`/knowledge?file=${encodeURIComponent(`company/${l.from}.md`)}`} className="grid gap-0.5 rounded-lg px-2 py-1.5 hover:bg-muted/50">
                <span className="text-sm">{l.title}</span>
                <span className="text-xs text-muted-foreground">{sub(l.fields).map(plain).filter(Boolean).join(" · ")}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    );
  });
}

function ClientProcesses({ clientId, onOpenTask }: { clientId: string; onOpenTask: (id: string) => void }) {
  const runs = useProcessRuns({ client: clientId });
  const processes = useProcesses();
  const forClients = (processes.data ?? []).filter((p) => p.for === "client" && !p.error);
  // one with inputs asks for them first
  const [starting, setStarting] = useState<Process | null>(null);
  if (!forClients.length && !runs.data?.length) return null;
  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between">
        <h2 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">Processes</h2>
        {forClients.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="xs" className="text-muted-foreground" />}>
              <PlusIcon />
              Start
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {forClients.map((p) => (
                <StartItem key={p.name} p={p} clientId={clientId} onAsk={() => setStarting(p)} />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {runs.data?.length ? (
        <ul className="grid gap-1.5">
          {runs.data.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                disabled={!r.current}
                onClick={() => r.current && onOpenTask(r.current.taskId)}
                className="grid w-full gap-1.5 rounded-lg border px-3 py-2.5 text-left hover:bg-muted/50 disabled:hover:bg-transparent"
              >
                <span className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate font-medium">
                    {r.processTitle}
                    {r.inputs[0]?.value ? <span className="font-normal text-muted-foreground"> · {inputText(r.inputs[0])}</span> : null}
                    {r.period ? <span className="font-normal text-muted-foreground"> · {r.period}</span> : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {r.step + 1}/{r.steps.length}
                  </span>
                </span>
                <span className="flex gap-0.5">
                  {r.steps.map((_, i) => (
                    <span key={i} className={cn("h-1 flex-1 rounded-full", i < r.step ? "bg-primary" : i === r.step ? (r.current?.status === "waiting" ? "bg-amber-500" : "bg-primary/40") : "bg-muted")} />
                  ))}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {r.steps[r.step]?.name}
                  {r.current && ` · ${r.current.status === "waiting" ? "waiting" : r.current.assigneeName}`}
                  {r.current?.dueAt && ` · due ${dueText(r.current.dueAt)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing going. Start one when it&rsquo;s time.</p>
      )}
      {starting && (
        <Dialog open onOpenChange={(o) => !o && setStarting(null)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Start {starting.title}</DialogTitle>
              <DialogDescription>Fill in what it needs; step 1, {starting.steps[0]?.name}, starts right away.</DialogDescription>
            </DialogHeader>
            <StartForm p={starting} clientId={clientId} onDone={() => setStarting(null)} />
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

function StartItem({ p, clientId, onAsk }: { p: Process; clientId: string; onAsk: () => void }) {
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: () => api<ProcessRun>("/process-runs", { process: p.name, clientId }),
    onSuccess: (r) => toast.success(`Started ${r.processTitle}`, { description: r.current ? `${r.steps[0]!.name}: ${r.current.assigneeName}` : undefined }),
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: processRunsQueryKey });
      void queryClient.invalidateQueries({ queryKey: processesQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    },
  });
  return (
    <DropdownMenuItem onClick={() => (p.inputs.length ? onAsk() : start.mutate())}>
      <WorkflowIcon />
      <span className="truncate">{p.title}</span>
    </DropdownMenuItem>
  );
}

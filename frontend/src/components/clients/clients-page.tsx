"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Client, ClientInput, ClientStage, Task, TeamMember } from "@emplio/shared";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  Building2Icon,
  CalendarIcon,
  CheckIcon,
  FileTextIcon,
  HourglassIcon,
  ListTodoIcon,
  PlusIcon,
  SearchIcon,
  UserPlusIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { api, clientsQueryKey, tasksQueryKey, useClients, useMe, useTasks } from "@/lib/api";
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

const notesHref = (c: Client) => `/knowledge?file=${encodeURIComponent(`company/knowledge/clients/${c.slug}.md`)}`;

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

      <Sheet open={!!current} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full gap-0 sm:max-w-md">
          {current && (
            <ClientDetails
              key={current.id}
              c={current}
              admin={admin}
              team={team.data ?? []}
              tasks={(tasks.data ?? []).filter((t) => t.clientId === current.id)}
              onChange={(body) => update.mutate({ id: current.id, ...body })}
            />
          )}
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

function ClientDetails({
  c,
  admin,
  team,
  tasks,
  onChange,
}: {
  c: Client;
  admin: boolean;
  team: TeamMember[];
  tasks: Task[];
  onChange: (body: ClientInput) => void;
}) {
  const [name, setName] = useState(c.name);
  const open = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const handlerIds = c.handlers.map((h) => h.id);
  const toggleHandler = (id: string) =>
    onChange({ handlerIds: handlerIds.includes(id) ? handlerIds.filter((h) => h !== id) : [...handlerIds, id] });
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
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={!admin}
              render={<Button variant="outline" className="w-full justify-between gap-2 px-3 font-normal" />}
            >
              <span className="truncate">
                {c.handlers.length ? c.handlers.map((h) => h.name).join(", ") : <span className="text-muted-foreground">Pick who looks after them</span>}
              </span>
              <ChevronDownIcon className="text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Who looks after {c.name}</DropdownMenuLabel>
                {team.map((m) => (
                  <DropdownMenuCheckboxItem key={m.id} checked={handlerIds.includes(m.id)} onCheckedChange={() => toggleHandler(m.id)} closeOnClick={false}>
                    <span className="grid min-w-0">
                      <span className="truncate">{m.name ?? m.email}</span>
                      {m.name && <span className="truncate text-xs text-muted-foreground">{m.email}</span>}
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

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
                  <Link href={`/tasks?task=${t.id}`} className="flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-muted/50">
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
                  </Link>
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

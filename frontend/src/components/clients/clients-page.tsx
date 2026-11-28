"use client";

import type {
  Client,
  ClientDetail,
  ClientField,
  ClientInput,
  ClientPage as ClientPageData,
  ClientStage,
  Contact,
  FieldKind,
  HistoryEntry,
  Process,
  ProcessRun,
  Project,
  Service,
  StageCategory,
  Task,
  TeamMember,
} from "@emplio/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  Building2Icon,
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  FileTextIcon,
  HistoryIcon,
  HourglassIcon,
  ListTodoIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Settings2Icon,
  Trash2Icon,
  UserPlusIcon,
  WorkflowIcon,
  ChevronDownIcon,
  LockIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AskFloat, useAskOpen } from "@/components/chat/composer";
import { useConfirm } from "@/components/confirm";
import { StartForm } from "@/components/processes/processes-page";
import { TaskPanel } from "@/components/tasks/tasks-page";
import { Avatar, Due, moneyText, RecordSheet, Search, statusText } from "@/components/things/things";
import { Badge } from "@/components/ui/badge";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  api,
  type Match,
  matchIn,
  processesQueryKey,
  processRunsQueryKey,
  recordsQueryKey,
  tasksQueryKey,
  useArchivedClients,
  useClientPage,
  useClients,
  useFields,
  useMe,
  useProcesses,
  useProcessRuns,
  useSaveRecord,
  useSaved,
  useServices,
  useStages,
} from "@/lib/api";
import { inputText } from "@/lib/process-inputs";
import { cn } from "@/lib/utils";
import { dateText, exactDate } from "@/lib/when";
import { CopyButton } from "./copy-button";
import { CATEGORY, QUIET, startedText, useStartsProcess } from "./shared";
import { StageSetup } from "./stage-setup";

export const initials = (name: string) =>
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

// a private record's notes are in restricted/ (owners' and admins')
export const notesFile = (kind: string, r: { slug: string; private?: boolean }) => `${r.private ? "restricted" : "company"}/${kind}/${r.slug}/index.md`;
const notesHref = (c: Client) => `/knowledge?file=${encodeURIComponent(notesFile("clients", c))}`;
const useRole = () => {
  const { data: me } = useMe();
  // not while still loading: a member would see the owner's buttons for a moment
  const role = me?.workspaces[0]?.role;
  return { admin: !!role && role !== "member", owner: role === "owner" };
};
export const useTeam = () => useQuery({ queryKey: ["team"], queryFn: () => api<TeamMember[]>("/team") });

export function Monogram({ c, size = "md" }: { c: { name: string; slug: string }; size?: "sm" | "md" | "lg" | "xl" }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-xl font-semibold",
        size === "xl" ? "size-14 text-lg" : size === "lg" ? "size-12 text-base" : size === "sm" ? "size-9 rounded-lg text-xs" : "size-10 text-sm",
        tint(c.slug),
      )}
      aria-hidden
    >
      {initials(c.name)}
    </span>
  );
}

const DOT: Record<StageCategory, string> = {
  active: "bg-primary",
  prospect: "bg-info",
  past: "bg-muted-foreground/50",
};
const PILL: Record<StageCategory, string> = {
  active: "bg-primary/10 text-primary",
  prospect: "bg-info/10 text-info",
  past: "bg-muted text-muted-foreground",
};
export function StagePill({ stage, category }: { stage: string; category: StageCategory }) {
  return (
    <Badge className={PILL[category]}>
      <span className={cn("size-1.5 rounded-full", DOT[category])} />
      {stage}
    </Badge>
  );
}

function Handlers({ c }: { c: Client }) {
  if (!c.handlers.length) return <span className="text-xs whitespace-nowrap text-muted-foreground/80 italic">Nobody named yet</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={c.handlers.map((h) => h.name).join(", ")}>
      <span className="flex -space-x-1.5">
        {c.handlers.slice(0, 3).map((h) => (
          <span key={h.id} className="grid size-5 place-items-center rounded-full bg-primary/10 text-[0.6rem] font-semibold text-primary ring-2 ring-background">
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

// "Did you mean Northwind?" under an add form: open the one there, or add this one anyway
export function MatchNote({ match, kind, href, onForce, children }: { match: Match; kind: string; href: string; onForce: () => void; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-xs">
      <span className="min-w-0 flex-1 text-pretty">
        {match.archived ? (
          <>
            <span className="font-medium">{match.name}</span> is an archived {kind}.
          </>
        ) : (
          <>
            There&rsquo;s a {kind} called <span className="font-medium">{match.name}</span> already.
          </>
        )}
      </span>
      {children}
      <Button size="xs" variant="outline" nativeButton={false} render={<Link href={href} scroll={false} />}>
        Open {match.name}
      </Button>
      <Button size="xs" variant="ghost" onClick={onForce}>
        Add anyway
      </Button>
    </div>
  );
}

// Who the business works for, read like a book of clients: how things stand, who looks after them, what's open.
// Emplio keeps them from chats and email; anyone can add one, owners and admins change stage and handlers.
export function ClientsPage() {
  const { admin } = useRole();
  const clients = useClients();
  const stages = useStages();
  const [filter, setFilter] = useState<StageCategory | "all" | "unhandled" | "archived">("active");
  const archived = useArchivedClients(true);
  const [query, setQuery] = useState("");
  const router = useRouter();
  // an old /clients?client=northwind link: their page
  const asked = useSearchParams().get("client");
  useEffect(() => void (asked && router.replace(`/clients/${asked}`)), [asked, router]);
  const [adding, setAdding] = useState(false);
  const [setup, setSetup] = useState(false);

  const all = clients.data ?? [];
  const inFilter = (c: Client, f: typeof filter) =>
    f === "unhandled" ? c.stageCategory === "active" && !c.handlers.length : f === "all" || f === "archived" || c.stageCategory === f;
  const FILTERS = [
    ...(["active", "prospect", "past"] as const).map((k) => ({
      value: k,
      label: CATEGORY[k].many,
      n: all.filter((c) => c.stageCategory === k).length,
    })),
    { value: "all" as const, label: "All", n: all.length },
    ...(archived.data?.length
      ? [
          {
            value: "archived" as const,
            label: "Archived",
            n: archived.data.length,
          },
        ]
      : []),
  ];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = filter === "archived" ? (archived.data ?? []) : all;
  const shown = pool
    .filter((c) => inFilter(c, filter))
    .filter((c) => words.every((w) => [c.name, c.stage, ...c.handlers.map((h) => h.name), ...c.details.map((d) => d.value)].join(" ").toLowerCase().includes(w)));
  const unhandled = all.filter((c) => c.stageCategory === "active" && !c.handlers.length).length;
  const waiting = all.reduce((n, c) => n + c.waitingTasks, 0);
  const active = all.filter((c) => c.stageCategory === "active").length;
  const prospects = all.filter((c) => c.stageCategory === "prospect").length;
  // a stage's own name is worth showing when it says more than the tab does (Onboarding under Active)
  const showStage = (c: Client) => filter === "all" || filter === "archived" || filter === "unhandled" || c.stage !== CATEGORY[c.stageCategory].label;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <AskFloat />
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <span className="px-2 font-sans text-sm font-medium tracking-normal">Clients</span>
      </header>

      <div className="under-tabs flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-5 px-4 py-5 sm:gap-6 sm:py-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="grid gap-1">
              <h1 className="font-heading text-xl font-semibold tracking-tight">Clients</h1>
              <p className="text-sm text-muted-foreground">
                {clients.isPending
                  ? "Loading…"
                  : all.length
                    ? [
                        `${active} active`,
                        prospects ? `${prospects} prospect${prospects === 1 ? "" : "s"}` : "",
                        waiting ? `${waiting} thing${waiting === 1 ? "" : "s"} waiting on clients` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "Who you work for, and who looks after each."}
              </p>
            </div>
            <div className="flex gap-2">
              {admin && (
                <Button size="sm" variant="outline" onClick={() => setSetup(true)}>
                  <Settings2Icon />
                  Stages and details
                </Button>
              )}
              <Button size="sm" onClick={() => setAdding(true)}>
                <PlusIcon />
                Add client
              </Button>
            </div>
          </div>

          {adding && <AddClient stages={stages.data ?? []} category={filter === "prospect" || filter === "past" ? filter : "active"} onDone={() => setAdding(false)} />}

          {admin && unhandled > 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-card px-3.5 py-3 text-sm">
              <UserPlusIcon className="mt-0.5 size-4 shrink-0 text-warning" />
              <p className="min-w-0 flex-1 text-pretty">
                <span className="font-medium">
                  {unhandled} active client{unhandled === 1 ? " has" : "s have"} nobody looking after {unhandled === 1 ? "it" : "them"}.
                </span>{" "}
                <span className="text-muted-foreground">Pick who handles each, so their work and reminders go to the right person.</span>
              </p>
              <Button
                size="xs"
                variant={filter === "unhandled" ? "ghost" : "outline"}
                className="shrink-0"
                onClick={() => setFilter(filter === "unhandled" ? "active" : "unhandled")}
              >
                {filter === "unhandled" ? "Show all" : "Show them"}
              </Button>
            </div>
          )}

          {all.length + (archived.data?.length ?? 0) > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)} className="shrink-0">
                <TabsList aria-label="Stage">
                  {FILTERS.map((f) => (
                    <TabsTrigger key={f.value} value={f.value} className="px-2.5 text-xs">
                      {f.label}
                      <span className="tabular-nums opacity-60">{f.n}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <div className="flex-1">
                <Search value={query} onChange={setQuery} placeholder="Search clients, people or details" />
              </div>
            </div>
          )}

          {clients.isPending ? (
            <div className="grid gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-xl" />
              ))}
            </div>
          ) : !all.length && !archived.data?.length ? (
            <div className="grid justify-items-center gap-2 rounded-xl border border-dashed px-6 py-14 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-muted">
                <Building2Icon className="size-5 text-muted-foreground" />
              </span>
              <p className="text-sm font-medium">No clients yet</p>
              <p className="max-w-sm text-sm text-pretty text-muted-foreground">
                Emplio adds them as they come up in chats and email. You can also add one, or just say &ldquo;Northwind is a new client, Sarah handles them&rdquo;.
              </p>
            </div>
          ) : !shown.length ? (
            <p className="py-12 text-center text-sm text-muted-foreground">{words.length ? <>No clients match &ldquo;{query.trim()}&rdquo;.</> : "None here."}</p>
          ) : (
            <ul className="grid gap-1.5">
              {shown.map((c) => (
                <li key={c.slug}>
                  <Link
                    href={`/clients/${c.slug}`}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border border-transparent px-2.5 py-2.5 text-left transition-colors hover:border-border hover:bg-muted focus-visible:border-ring focus-visible:outline-none",
                      c.archivedAt && "opacity-60",
                    )}
                  >
                    <Monogram c={c} />
                    <span className="grid min-w-0 flex-1 gap-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          <Named name={c.name} private={c.private} />
                        </span>
                        {showStage(c) && <StagePill stage={c.stage} category={c.stageCategory} />}
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
                      {c.waitingTasks > 0 ? (
                        <span className="inline-flex items-center gap-1 text-warning">
                          <HourglassIcon className="size-3" />
                          {c.waitingTasks} waiting
                        </span>
                      ) : c.activeProjects > 0 ? (
                        <span className="text-muted-foreground">
                          {c.activeProjects} project
                          {c.activeProjects === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <Dialog open={setup} onOpenChange={setSetup}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Stages and details</DialogTitle>
            <DialogDescription>Your own words for where a client is, and the details you keep on every client.</DialogDescription>
          </DialogHeader>
          <StageSetup />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StageSelect({
  stages,
  value,
  onChange,
  disabled,
  className,
}: {
  stages: ClientStage[];
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const items = stages.map((s) => ({ value: s.name, label: s.name }));
  return (
    <Select items={items} value={value} disabled={disabled} onValueChange={(v) => v && v !== value && onChange(v as string)}>
      <SelectTrigger size="sm" aria-label="Stage" className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {stages.map((s) => (
          <SelectItem key={s.id} value={s.name}>
            <span className="flex items-center gap-2">
              <span className={cn("size-1.5 rounded-full", DOT[s.category])} />
              <span>{s.name}</span>
              {s.name !== CATEGORY[s.category].label && <span className="text-xs text-muted-foreground">{CATEGORY[s.category].label}</span>}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AddClient({ stages, category, onDone }: { stages: ClientStage[]; category: StageCategory; onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [stage, setStage] = useState("");
  const picked = stage || stages.find((s) => s.category === category)?.name || "";
  const add = useSaveRecord((body: ClientInput) => api<Client>("/clients", body), {
    silent: true,
    done: (c) => {
      toast.success(`Added ${c.name}`, {
        action: {
          label: "Open",
          onClick: () => router.push(`/clients/${c.slug}`),
        },
      });
      onDone();
    },
  });
  const match = matchIn(add.error);
  return (
    <form
      className="grid gap-2 rounded-xl border bg-background p-2 shadow-xs focus-within:ring-2 focus-within:ring-ring/30"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) add.mutate({ name, stage: picked });
      }}
    >
      <Input
        autoFocus
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          add.reset();
        }}
        onKeyDown={(e) => e.key === "Escape" && onDone()}
        placeholder="Client name, e.g. Northwind Traders"
        aria-label="Client name"
        className="border-0 bg-transparent focus-visible:ring-0 dark:bg-transparent"
      />
      {match && <MatchNote match={match} kind="client" href={`/clients/${match.slug}`} onForce={() => add.mutate({ name, stage: picked, force: true })} />}
      <div className="flex items-center gap-2">
        <StageSelect stages={stages} value={picked} onChange={setStage} className="w-40" />
        {add.error && !match && <p className="min-w-0 truncate text-xs text-destructive">{add.error.message}</p>}
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
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// One detail of the business's list (Tax number, Files, Renewal): a box of its kind, saved when left. Anyone fills them.
export function FieldInput({ f, value, onChange, disabled }: { f: ClientField; value: string; onChange: (v: string | null) => void; disabled?: boolean }) {
  const [v, setV] = useSaved(value);
  if (f.type === "choice") {
    const items = [{ value: "", label: "Empty" }, ...f.options.map((o) => ({ value: o, label: o }))];
    return (
      <Select items={items} value={value} disabled={disabled} onValueChange={(n) => (n ?? "") !== value && onChange((n as string) || null)}>
        <SelectTrigger aria-label={f.name} className={cn(QUIET, "w-full", !value && "text-muted-foreground/50")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  const save = () => (v.trim() !== value ? onChange(v.trim() || null) : undefined);
  return (
    <div className="group relative">
      <Input
        aria-label={f.name}
        placeholder={disabled ? "—" : "Empty"}
        disabled={disabled}
        type={f.type === "date" ? "date" : "text"}
        inputMode={f.type === "number" ? "decimal" : undefined}
        value={v}
        title={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className={cn(QUIET, "truncate placeholder:text-muted-foreground/50")}
      />
      {f.type !== "date" && <CopyButton value={value} label={f.name} />}
    </div>
  );
}

// a client page's box: a small title (and count), then rows
export function Card({ title, count, action, children }: { title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="grid min-w-0 gap-1 rounded-xl border bg-card p-2">
      <div className="flex h-8 items-center justify-between gap-2 px-2">
        <h2 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">
          {title}
          {!!count && <span className="ml-1.5 tabular-nums opacity-60">{count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
export const ROW = "flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none";

const pageKey = (slug: string) => [...recordsQueryKey, "client", slug];

// A client's own page (/clients/northwind): how they're handled and what they're like on the side, their work in the
// middle. Their contacts and projects open in a side panel over it (?open=projects/...).
export function ClientPage({ slug }: { slug: string }) {
  const page = useClientPage(slug);
  const c = page.data?.client;
  const [taskId, setTaskId] = useState<string | null>(null);
  useAskOpen(
    c && {
      kind: "client",
      title: c.name,
      ref: notesFile("clients", c),
    },
  );
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <AskFloat />
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <Link href="/clients" className="px-2 font-sans text-sm tracking-normal text-muted-foreground hover:text-foreground">
          Clients
        </Link>
        <ChevronRightIcon className="size-3.5 text-muted-foreground" />
        <span className="truncate px-2 font-sans text-sm font-medium tracking-normal">{c?.name ?? ""}</span>
      </header>
      <div className="under-tabs flex min-h-0 flex-1 flex-col overflow-y-auto">
        {!page.data ? (
          <div className="mx-auto grid w-full max-w-5xl gap-3 px-4 py-8">
            {page.isPending ? <Skeleton className="h-12 w-1/2" /> : <p className="text-sm text-muted-foreground">There&rsquo;s no client called &ldquo;{slug}&rdquo;.</p>}
          </div>
        ) : (
          <ClientDetails key={page.data.client.slug} data={page.data} onOpenTask={setTaskId} />
        )}
      </div>
      <Sheet open={!!taskId} onOpenChange={(o) => !o && setTaskId(null)}>
        <SheetContent className="w-full gap-0 overflow-x-hidden sm:max-w-md">{taskId && <TaskPanel id={taskId} onRemoved={() => setTaskId(null)} />}</SheetContent>
      </Sheet>
      <RecordSheet />
    </div>
  );
}

function ClientDetails({ data, onOpenTask }: { data: ClientPageData; onOpenTask: (id: string) => void }) {
  const c = data.client;
  const { admin, owner } = useRole();
  const router = useRouter();
  const qc = useQueryClient();
  const stages = useStages().data ?? [];
  const team = useTeam().data ?? [];
  const [dialog, confirm] = useConfirm();
  const [name, setName] = useSaved(c.name);
  // the answer has the new updatedAt: kept at once, so a second change right after isn't refused as stale
  const keep = (out: Client) => qc.setQueryData<ClientPageData>(pageKey(c.slug), (old) => old && { ...old, client: out });
  const update = useSaveRecord((body: ClientInput) => api<Client>(`/clients/${c.slug}`, { ...body, updatedAt: c.updatedAt }, "PATCH"), { done: keep });
  const archive = useSaveRecord((withWork: boolean) => api<Client>(`/clients/${c.slug}/archive`, { withWork }), { done: (out) => (keep(out), toast(`Archived ${c.name}`)) });
  const restore = useSaveRecord(() => api<Client>(`/clients/${c.slug}/restore`, {}), { done: (out) => (keep(out), toast(`${c.name} is back`)) });
  const purge = useSaveRecord(() => api(`/clients/${c.slug}`, undefined, "DELETE"), { done: () => (toast(`Deleted ${c.name}`), router.replace("/clients")) });
  const askArchive = () => {
    const work = [
      c.openTasks && `${c.openTasks} open task${c.openTasks === 1 ? "" : "s"}`,
      c.activeProjects && `${c.activeProjects} active project${c.activeProjects === 1 ? "" : "s"}`,
    ].filter(Boolean);
    confirm({
      title: `Archive ${c.name}?`,
      description: work.length
        ? `They still have ${work.join(" and ")}. Those stay as they are; ${c.name} leaves your lists and Emplio stops treating them as a client. You can bring them back any time.`
        : `${c.name} leaves your lists and Emplio stops treating them as a client. Their notes, projects and history are kept, and you can bring them back any time.`,
      action: "Archive",
      safe: true,
      onConfirm: () => archive.mutate(work.length > 0),
    });
  };
  const open = data.tasks;
  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)] gap-6 px-4 py-6 sm:py-10">
      {dialog}
      {c.archivedAt && (
        <div className="flex items-center gap-3 rounded-xl border bg-muted px-3.5 py-2.5 text-sm">
          <ArchiveIcon className="size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1">Archived {dateText(c.archivedAt.slice(0, 10))}. Emplio doesn&rsquo;t treat them as a client.</p>
          {admin && (
            <Button size="xs" variant="outline" onClick={() => restore.mutate(undefined)}>
              Bring back
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <Monogram c={c} size="xl" />
        <div className="grid min-w-[min(100%,14rem)] flex-1 basis-0 gap-1.5">
          {admin ? (
            <Input
              aria-label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => (name.trim() && name.trim() !== c.name ? update.mutate({ name }) : setName(c.name))}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              className={cn(QUIET, "-ml-2 h-auto py-0.5 font-heading text-2xl font-semibold tracking-tight md:text-2xl")}
            />
          ) : (
            <h1 className="truncate font-heading text-2xl font-semibold tracking-tight">{c.name}</h1>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <StagePill stage={c.stage} category={c.stageCategory} />
            <Handlers c={c} />
            <span className="tabular-nums">{data.tasksTotal ? `${data.tasksTotal} open` : "Nothing open"}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href={notesHref(c)} />}>
            <FileTextIcon />
            Notes
          </Button>
          <Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/tasks?client=${c.slug}`} />}>
            <ListTodoIcon />
            Their tasks
          </Button>
          {admin && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="More" />}>
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {c.archivedAt ? (
                  <DropdownMenuItem onClick={() => restore.mutate(undefined)}>
                    <ArchiveRestoreIcon />
                    Bring back
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={askArchive}>
                    <ArchiveIcon />
                    Archive
                  </DropdownMenuItem>
                )}
                {owner && c.archivedAt && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() =>
                        confirm({
                          title: `Delete ${c.name} for good?`,
                          description:
                            "Only for a client added by mistake: this can't be undone. A client with projects, contacts or tasks can't be deleted; archive them instead.",
                          action: "Delete for good",
                          onConfirm: () => purge.mutate(undefined),
                        })
                      }
                    >
                      <Trash2Icon />
                      Delete for good
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 gap-4">
          <ClientProcesses slug={c.slug} onOpenTask={onOpenTask} />

          <Card title="Open work" count={data.tasksTotal}>
            {open.length ? (
              <ul className="grid">
                {open.map((t) => (
                  <li key={t.id}>
                    <TaskRow t={t} onOpen={onOpenTask} />
                  </li>
                ))}
                {data.tasksTotal > open.length && (
                  <li>
                    <Link href={`/tasks?client=${c.slug}`} className={cn(ROW, "text-sm text-muted-foreground")}>
                      All {data.tasksTotal} open tasks
                    </Link>
                  </li>
                )}
              </ul>
            ) : (
              <p className="flex items-center gap-2 px-2 pb-2 text-sm text-muted-foreground">
                <CheckIcon className="size-4" />
                Nothing open for {c.name}.
              </p>
            )}
          </Card>

          <ClientProjects c={c} projects={data.projects} />
          <History entries={data.history} />
        </div>

        <aside className="grid min-w-0 gap-4">
          <Card title="About">
            <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 px-2 pb-1 text-sm">
              <Label className="font-normal text-muted-foreground">Stage</Label>
              <StageSelect stages={stages} value={c.stage} disabled={!admin} onChange={(stage) => update.mutate({ stage })} className={cn(QUIET, "w-full")} />
              <Label className="self-start pt-2 font-normal text-muted-foreground">Handled by</Label>
              <HandlerPicker clientName={c.name} team={team} value={c.handlers.map((h) => h.id)} disabled={!admin} onChange={(handlers) => update.mutate({ handlers })} />
              <Details kind="client" details={c.details} onSave={(details) => update.mutate({ details })} />
              <PrivateSwitch on={c.private} what="Only owners, admins and the people who handle it see this client, its projects and the contacts who are only here." onChange={(on) => update.mutate({ private: on })} />
            </div>
          </Card>

          <ClientContacts c={c} contacts={data.contacts} />

          {data.meetings.length > 0 && (
            <Card title="Meetings" count={data.meetings.length}>
              <ul className="grid">
                {data.meetings.map((m) => (
                  <li key={m.path}>
                    <Link href={`/knowledge?file=${encodeURIComponent(m.path)}`} className={ROW}>
                      <CalendarIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">{m.title}</span>
                      {m.date && <span className="shrink-0 text-xs text-muted-foreground">{dateText(m.date)}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {data.notes.length > 0 && (
            <Card title="Mentioned in" count={data.notes.length}>
              <ul className="grid">
                {data.notes.map((n) => (
                  <li key={n.path}>
                    <Link href={`/knowledge?file=${encodeURIComponent(n.path)}`} className={ROW}>
                      <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">{n.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}

// a row as a shadcn button: none of the button's own height, centring or one-line text
const RAW = "h-auto justify-start whitespace-normal text-left font-normal";

function TaskRow({ t, onOpen }: { t: Task; onOpen: (id: string) => void }) {
  return (
    <Button variant="ghost" onClick={() => onOpen(t.id)} className={cn(ROW, RAW, "w-full items-start")}>
      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", t.status === "waiting" ? "bg-warning" : t.status === "doing" ? "bg-info" : "bg-muted-foreground/40")} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-sm">{t.title}</span>
        <span className="flex min-w-0 flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span className="truncate">{t.assigneeId ? t.assigneeName : (t.agentName ?? "Emplio")}</span>
          {t.project && <span className="truncate">{t.project.name}</span>}
          {t.waitingOn && <span className="truncate text-warning">Waiting on {t.waitingOn}</span>}
        </span>
      </span>
      {t.dueAt && (
        <span
          className={cn(
            "mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums",
            new Date(t.dueAt) < new Date() && "font-medium text-destructive",
          )}
        >
          <CalendarIcon className="size-3" />
          {dueText(t.dueAt)}
        </span>
      )}
    </Button>
  );
}

// A name, with a lock when only owners and admins see it
export function Named({ name, private: on }: { name: string; private?: boolean }) {
  return (
    <>
      {name}
      {on && <LockIcon aria-label="Private" className="ml-1.5 inline size-3.5 align-[-2px] text-muted-foreground" />}
    </>
  );
}

// Owners and admins: make a record theirs alone (private.ts: its notes move to restricted/)
// because: private with its client (that client's name), so only that client's switch shares it
export function PrivateSwitch({ on, what, because, onChange }: { on: boolean; what: string; because?: string | null; onChange: (on: boolean) => void }) {
  const { admin } = useRole();
  if (!admin) return null;
  return (
    <label className={cn("col-span-2 flex items-start gap-3 rounded-lg px-2 py-2", because ? "cursor-default" : "cursor-pointer hover:bg-muted/50")}>
      <Switch checked={on} disabled={!!because} onCheckedChange={onChange} className="mt-0.5" />
      <span className="grid gap-0.5">
        <span className="flex items-center gap-1.5 text-sm">
          <LockIcon className="size-3.5 text-muted-foreground" />
          Private
        </span>
        <span className="text-xs text-pretty text-muted-foreground">{because ? `Private because ${because} is. Share ${because} to share this too.` : what}</span>
      </span>
    </label>
  );
}

// The business's own details on a record, each saved when left; owners and admins add a new one in place
export function Details({ kind, details, onSave, disabled }: { kind: FieldKind; details: ClientDetail[]; onSave: (d: Record<string, string | null>) => void; disabled?: boolean }) {
  const { admin } = useRole();
  const fields = useFields(kind).data ?? [];
  return (
    <>
      {fields.map((f) => (
        <div key={f.id} className="col-span-2 grid grid-cols-subgrid items-center">
          <Label className="truncate font-normal text-muted-foreground" title={f.name}>
            {f.name}
          </Label>
          <FieldInput f={f} value={details.find((d) => d.key === f.key)?.value ?? ""} disabled={disabled} onChange={(v) => onSave({ [f.key]: v })} />
        </div>
      ))}
      {admin && !disabled && <AddField onAdd={(name, value) => onSave({ [name]: value })} />}
    </>
  );
}

// a detail not on the list yet: it joins the list for every record of the kind (as text; its kind changes in the details setup)
function AddField({ onAdd }: { onAdd: (name: string, value: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  if (!adding)
    return (
      <Button variant="ghost" size="sm" onClick={() => setAdding(true)} className="col-span-2 -ml-2 justify-self-start text-muted-foreground">
        <PlusIcon />
        Add a detail
      </Button>
    );
  return (
    <form
      className="col-span-2 grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-x-2 py-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !value.trim()) return;
        onAdd(name.trim(), value.trim());
        setName("");
        setValue("");
        setAdding(false);
      }}
      onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
    >
      <Input autoFocus aria-label="Detail" placeholder="Detail" value={name} onChange={(e) => setName(e.target.value)} />
      <Input aria-label="Value" placeholder="Value" value={value} onChange={(e) => setValue(e.target.value)} />
      <Button type="submit" variant="ghost" size="icon-sm" aria-label="Add detail" disabled={!name.trim() || !value.trim()}>
        <CheckIcon />
      </Button>
    </form>
  );
}

// Who looks after a client: type to find someone, pick as many as handle them, remove with the x.
export function HandlerPicker({
  clientName,
  team,
  value,
  disabled,
  onChange,
}: {
  clientName: string;
  team: TeamMember[];
  value: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
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
      <ComboboxChips ref={anchor} className={cn(QUIET, "h-auto min-h-8 w-full px-1 focus-within:border-input")}>
        <ComboboxValue>
          {(picked: TeamMember[]) => (
            <>
              {picked.map((m) => (
                <ComboboxChip key={m.id}>{m.name ?? m.email}</ComboboxChip>
              ))}
              <ComboboxChipsInput aria-label={`Who looks after ${clientName}`} placeholder={picked.length ? "Add someone" : disabled ? "Nobody yet" : "Pick someone"} />
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
                <span className="truncate text-xs text-muted-foreground">{m.title ?? (m.name ? m.email : "")}</span>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

// The people at this client, each with their role here; adding one links them to this client.
function ClientContacts({ c, contacts }: { c: Client; contacts: Contact[] }) {
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", role: "", email: "" });
  const add = useSaveRecord(
    (force: boolean) =>
      api<Contact>("/contacts", {
        name: f.name,
        email: f.email.trim() || null,
        clients: [{ client: c.slug, role: f.role.trim() || null }],
        force,
      }),
    {
      silent: true,
      done: () => (setF({ name: "", role: "", email: "" }), setAdding(false)),
    },
  );
  // the one already there: linked to this client too, with the role typed
  const link = useSaveRecord(
    async (m: Match) => {
      const { contact } = await api<{ contact: Contact }>(`/contacts/${m.slug}`);
      return api<Contact>(
        `/contacts/${m.slug}`,
        {
          clients: [...contact.clients.map((x) => ({ client: x.slug, role: x.role })), { client: c.slug, role: f.role.trim() || null }],
          updatedAt: contact.updatedAt,
        },
        "PATCH",
      );
    },
    {
      done: (out) => (toast(`${out.name} is linked to ${c.name}`), setF({ name: "", role: "", email: "" }), setAdding(false)),
    },
  );
  const match = matchIn(add.error);
  return (
    <Card
      title="Contacts"
      count={contacts.length}
      action={
        !adding && (
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add
          </Button>
        )
      }
    >
      {adding && (
        <form
          className="grid gap-1.5 px-2 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (f.name.trim()) add.mutate(false);
          }}
          onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
        >
          <Input autoFocus placeholder="Name" aria-label="Name" value={f.name} onChange={(e) => (setF({ ...f, name: e.target.value }), add.reset())} />
          <div className="grid grid-cols-2 gap-1.5">
            <Input placeholder="Role here, e.g. Finance lead" aria-label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} />
            <Input placeholder="Email" aria-label="Email" type="email" value={f.email} onChange={(e) => (setF({ ...f, email: e.target.value }), add.reset())} />
          </div>
          {match ? (
            <MatchNote match={match} kind="contact" href={`?open=${encodeURIComponent(`contacts/${match.slug}`)}`} onForce={() => add.mutate(true)}>
              {!match.archived && (
                <Button size="xs" onClick={() => link.mutate(match)}>
                  Link to {c.name}
                </Button>
              )}
            </MatchNote>
          ) : (
            add.error && <p className="text-xs text-destructive">{add.error.message}</p>
          )}
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="xs" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={!f.name.trim() || add.isPending}>
              Add contact
            </Button>
          </div>
        </form>
      )}
      {contacts.length ? (
        <ul className="grid">
          {contacts.map((p) => {
            const role = p.clients.find((x) => x.id === c.id)?.role;
            return (
              <li key={p.id}>
                <Link href={`?open=${encodeURIComponent(`contacts/${p.slug}`)}`} scroll={false} className={ROW}>
                  <Avatar name={p.name} />
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate text-sm">{p.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{[role ?? p.title, p.email ?? p.phone].filter(Boolean).join(" · ") || "No details yet"}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        !adding && <p className="px-2 pb-2 text-sm text-muted-foreground">Nobody yet. Emplio adds people as they write in.</p>
      )}
    </Card>
  );
}

// What this client is buying: each project with its lead and due date; a new one can start its service's process.
function ClientProjects({ c, projects }: { c: Client; projects: Project[] }) {
  const services = useServices().data ?? [];
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [service, setService] = useState("");
  const add = useSaveRecord(
    (force: boolean) =>
      api<Project & { started: string | null }>("/projects", {
        name,
        client: c.slug,
        service: service || null,
        force,
      }),
    {
      silent: true,
      done: (p) => {
        toast.success(`Added ${p.name}`, {
          description: startedText(p.started),
        });
        setName("");
        setService("");
        setAdding(false);
      },
    },
  );
  const match = matchIn(add.error);
  const starts = useStartsProcess(services.find((s) => s.slug === service));
  const items = [{ value: "", label: "No service" }, ...services.map((s: Service) => ({ value: s.slug, label: s.name }))];
  const open = projects.filter((p) => p.status === "active" || p.status === "on_hold");
  const closed = projects.filter((p) => !open.includes(p));
  return (
    <Card
      title="Projects"
      count={open.length}
      action={
        !adding && (
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add
          </Button>
        )
      }
    >
      {adding && (
        <form
          className="grid gap-1.5 px-2 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) add.mutate(false);
          }}
          onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
        >
          <div className="grid gap-1.5">
            <Input
              autoFocus
              placeholder="Project, e.g. Website rebuild"
              aria-label="Project name"
              value={name}
              onChange={(e) => (setName(e.target.value), add.reset())}
            />
            <Select items={items} value={service} onValueChange={(v) => setService((v as string) ?? "")}>
              <SelectTrigger size="sm" aria-label="Service" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {starts && (
            <p className="px-1 text-xs text-muted-foreground">
              Adding it starts {starts} for {c.name}.
            </p>
          )}
          {match ? (
            <MatchNote match={match} kind="project" href={`?open=${encodeURIComponent(`projects/${match.slug}`)}`} onForce={() => add.mutate(true)} />
          ) : (
            add.error && <p className="text-xs text-destructive">{add.error.message}</p>
          )}
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="xs" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={!name.trim() || add.isPending}>
              Add project
            </Button>
          </div>
        </form>
      )}
      {projects.length ? (
        <ul className="grid">
          {[...open, ...closed].map((p) => (
            <li key={p.id}>
              <Link href={`?open=${encodeURIComponent(`projects/${p.slug}`)}`} scroll={false} className={cn(ROW, closed.includes(p) && "opacity-60")}>
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-sm">{p.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {[p.service?.name, p.lead && `${p.lead.name} leads`, p.status !== "active" && statusText(p.status), moneyText(p)].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums">
                  <Due due={p.dueOn ?? undefined} done={closed.includes(p)} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        !adding && <p className="px-2 pb-2 text-sm text-muted-foreground">No projects yet.</p>
      )}
    </Card>
  );
}

// what changed, by whom, newest first: the audit trail an owner checks when a number looks wrong
const VIA: Record<string, string> = {
  emplio: "via Emplio",
  import: "imported",
  system: "automatic",
};
const valueText = (v: unknown) =>
  v === null || v === undefined || v === ""
    ? "empty"
    : Array.isArray(v)
      ? v.join(", ") || "nobody"
      : typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T|$)/.test(v)
        ? dateText(v.slice(0, 10))
        : String(v);
// folded until asked for: it's for checking, not for reading every time the page opens
export function History({ entries }: { entries: HistoryEntry[] }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  if (!entries.length) return null;
  const shown = all ? entries : entries.slice(0, 6);
  return (
    <Card
      title="History"
      count={entries.length}
      action={
        <Button variant="ghost" size="xs" className="text-muted-foreground" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
          <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
        </Button>
      }
    >
      {open && (
        <>
          <ul className="grid gap-0.5 px-2 pb-1">
            {shown.map((h) => (
              <li key={h.id} className="flex items-start gap-3 py-1.5 text-sm">
                <HistoryIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-pretty">{h.summary}</span>
                  {h.changes.length > 0 && !/^(Added|Moved|Archived|Brought back)/.test(h.summary) && (
                    <span className="grid text-xs text-muted-foreground">
                      {h.changes.slice(0, 4).map((c) => (
                        <span key={c.field} className="truncate">
                          {c.field}: {valueText(c.from)} → <span className="text-foreground">{valueText(c.to)}</span>
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground" title={exactDate(h.at)}>
                    {[
                      h.who ?? (h.via === "emplio" ? "Emplio" : null),
                      h.via && VIA[h.via],
                      new Date(h.at).toLocaleString("en-GB", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {entries.length > shown.length && (
            <Button variant="ghost" size="xs" className="justify-self-start text-muted-foreground" onClick={() => setAll(true)}>
              Show all {entries.length}
            </Button>
          )}
        </>
      )}
    </Card>
  );
}

// The processes going for this client, the step each is on, and starting another.
function ClientProcesses({ slug, onOpenTask }: { slug: string; onOpenTask: (id: string) => void }) {
  const runs = useProcessRuns({ client: slug });
  const processes = useProcesses();
  const forClients = (processes.data ?? []).filter((p) => p.for === "client" && !p.error);
  // one with inputs asks for them first
  const [starting, setStarting] = useState<Process | null>(null);
  if (!forClients.length && !runs.data?.length) return null;
  return (
    <Card
      title="Processes"
      count={runs.data?.length}
      action={
        forClients.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="xs" className="text-muted-foreground" />}>
              <PlusIcon />
              Start
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {forClients.map((p) => (
                <StartItem key={p.name} p={p} slug={slug} onAsk={() => setStarting(p)} />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      }
    >
      {runs.data?.length ? (
        <ul className="grid">
          {runs.data.map((r) => (
            <li key={r.id}>
              <Button
                variant="ghost"
                disabled={!r.current}
                onClick={() => r.current && onOpenTask(r.current.taskId)}
                className={cn(ROW, RAW, "grid w-full gap-2 py-2.5 disabled:opacity-100 disabled:hover:bg-transparent")}
              >
                <span className="flex min-w-0 items-center justify-between gap-3 text-sm">
                  <span className="truncate font-medium">
                    {r.processTitle}
                    {r.project ? (
                      <span className="font-normal text-muted-foreground"> · {r.project.name}</span>
                    ) : r.inputs[0]?.value ? (
                      <span className="font-normal text-muted-foreground"> · {inputText(r.inputs[0])}</span>
                    ) : null}
                    {r.period ? <span className="font-normal text-muted-foreground"> · {r.period}</span> : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    Step {r.step + 1} of {r.steps.length}
                  </span>
                </span>
                <span className="flex w-full gap-1">
                  {r.steps.map((_, i) => (
                    <span
                      key={i}
                      className={cn(
                        "h-1 flex-1 rounded-full",
                        i < r.step ? "bg-primary" : i === r.step ? (r.current?.status === "waiting" ? "bg-warning" : "bg-primary/40") : "bg-muted",
                      )}
                    />
                  ))}
                </span>
                <span className="flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="truncate">
                    {r.steps[r.step]?.name}
                    {r.current && ` · ${r.current.status === "waiting" ? "waiting" : r.current.assigneeName}`}
                  </span>
                  {r.current?.dueAt && <span className="shrink-0 tabular-nums">due {dueText(r.current.dueAt)}</span>}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2 pb-2 text-sm text-muted-foreground">Nothing ongoing. Start one when it&rsquo;s time.</p>
      )}
      {starting && (
        <Dialog open onOpenChange={(o) => !o && setStarting(null)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Start {starting.title}</DialogTitle>
              <DialogDescription>Fill in what it needs; step 1, {starting.steps[0]?.name}, starts right away.</DialogDescription>
            </DialogHeader>
            <StartForm p={starting} clientId={slug} onDone={() => setStarting(null)} />
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}

function StartItem({ p, slug, onAsk }: { p: Process; slug: string; onAsk: () => void }) {
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: () => api<ProcessRun>("/process-runs", { process: p.name, client: slug }),
    onSuccess: (r) =>
      toast.success(`Started ${r.processTitle}`, {
        description: r.current ? `${r.steps[0]!.name}: ${r.current.assigneeName}` : undefined,
      }),
    onError: (e) => toast.error(e.message),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: processRunsQueryKey });
      void queryClient.invalidateQueries({ queryKey: processesQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: recordsQueryKey });
    },
  });
  return (
    <DropdownMenuItem onClick={() => (p.inputs.length ? onAsk() : start.mutate())}>
      <WorkflowIcon />
      <span className="truncate">{p.title}</span>
    </DropdownMenuItem>
  );
}

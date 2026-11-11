"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Task, TaskInput, TaskStatus, TeamMember } from "@emplio/shared";
import { BotIcon, CalendarIcon, CheckIcon, ChevronRightIcon, ClipboardListIcon, MessageSquareIcon, PlayIcon, PlusIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useConfirm } from "@/components/confirm";
import { Textarea } from "@/components/ui/textarea";
import { api, tasksQueryKey, useMe, useTasks } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Repeating } from "@/components/tasks/repeating";

const STATUS: { value: TaskStatus; label: string }[] = [
  { value: "todo", label: "To do" },
  { value: "doing", label: "Doing" },
  { value: "waiting", label: "Waiting" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];
const LABEL = Object.fromEntries(STATUS.map((s) => [s.value, s.label])) as Record<TaskStatus, string>;
const AI = "ai";
const SHOW = [
  { value: "all", label: "Everyone" },
  { value: "mine", label: "Mine" },
  { value: "ai", label: "Emplio" },
];

// every word of the search somewhere in the task: its title, notes, who it's waiting on, who does it or asked
const matches = (t: Task, words: string[]) => {
  const text = [t.title, t.notes, t.waitingOn, t.assigneeId ? t.assigneeName : "Emplio", t.requesterName].join(" ").toLowerCase();
  return words.every((w) => text.includes(w));
};

const isOpen = (t: Task) => t.status !== "done" && t.status !== "cancelled";
const isLate = (t: Task) => isOpen(t) && !!t.dueAt && new Date(t.dueAt) < new Date();
// the date part of an ISO time, local, for <input type="date">
const dateOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA") : "");

function dueText(iso: string) {
  const d = new Date(iso);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() && { year: "numeric" }) });
}

// soonest first, no due date last
const byDue = (a: Task, b: Task) => (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~") || b.createdAt.localeCompare(a.createdAt);
const WEEK = 7 * 86_400_000;

const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

function Person({ t, short }: { t: Task; short?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={t.assigneeName}>
      {t.assigneeId ? (
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[0.65rem] font-semibold text-primary">
          {initials(t.assigneeName)}
        </span>
      ) : (
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-foreground text-background">
          <BotIcon className="size-3" />
        </span>
      )}
      {!short && <span className="truncate">{t.assigneeId ? t.assigneeName : "Emplio"}</span>}
    </span>
  );
}

function Due({ t }: { t: Task }) {
  if (!t.dueAt) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground",
        isLate(t) && "font-medium text-destructive",
      )}
    >
      <CalendarIcon className="size-3" />
      {dueText(t.dueAt)}
    </span>
  );
}

function StatusPill({ status }: { status: TaskStatus }) {
  if (status === "todo") return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[0.65rem] font-medium",
        status === "doing" && "bg-blue-500/10 text-blue-700 dark:text-blue-300",
        status === "waiting" && "bg-amber-500/15 text-amber-800 dark:text-amber-300",
        (status === "done" || status === "cancelled") && "bg-muted text-muted-foreground",
      )}
    >
      {LABEL[status]}
    </span>
  );
}

// Everything to be done in the business, by people and by Emplio, read top to bottom like a morning check:
// what needs you, what Emplio is on, what's coming up (and what repeats), and what got done this week.
// Opening one shows all of it, editable. Emplio adds and updates them from chats too.
export function TasksPage() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const tasks = useTasks();
  const team = useQuery({ queryKey: ["team"], queryFn: () => api<TeamMember[]>("/team") });
  const [show, setShow] = useState("all");
  const [query, setQuery] = useState("");
  const [showDone, setShowDone] = useState(false);
  // /tasks?task=<id> (an @mentioned task clicked in a chat): open it
  const [openId, setOpenId] = useState<string | null>(useSearchParams().get("task"));
  const [confirmDialog, confirm] = useConfirm();

  const update = useMutation({
    mutationFn: ({ id, ...body }: TaskInput & { id: string }) => api<Task>(`/tasks/${id}`, body, "PATCH"),
    // show it straight away; the server's answer replaces it
    onMutate: ({ id, ...body }) =>
      queryClient.setQueryData<Task[]>(tasksQueryKey, (old) =>
        old?.map((t) => (t.id === id ? { ...t, ...(body as Partial<Task>), ...(body.dueAt !== undefined && { dueAt: body.dueAt && new Date(`${body.dueAt}T18:00:00+05:30`).toISOString() }) } : t)),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: tasksQueryKey }),
  });
  const start = useMutation({
    mutationFn: (id: string) => api<Task>(`/tasks/${id}/start`, {}),
    onSettled: () => queryClient.invalidateQueries({ queryKey: tasksQueryKey }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/tasks/${id}`, undefined, "DELETE"),
    onMutate: (id) => {
      setOpenId(null);
      queryClient.setQueryData<Task[]>(tasksQueryKey, (old) => old?.filter((t) => t.id !== id));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: tasksQueryKey }),
  });

  const people = [{ value: AI, label: "Emplio" }, ...(team.data ?? []).map((m) => ({ value: m.id, label: m.name ?? m.email }))];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const all = (tasks.data ?? [])
    .filter((t) => (show === "mine" ? t.assigneeId === me?.user.id || t.requesterId === me?.user.id : show === "ai" ? !t.assigneeId : true))
    .filter((t) => matches(t, words))
    .sort(byDue);
  const openTasks = all.filter(isOpen);
  // first in the list: what's waiting on me. Mine due by tonight, and Emplio's that stopped for my look
  const endOfToday = new Date().setHours(24, 0, 0, 0);
  const needsMe = (t: Task) =>
    (t.assigneeId === me?.user.id && !!t.dueAt && new Date(t.dueAt).getTime() < endOfToday) ||
    (!t.assigneeId && t.status === "waiting" && t.requesterId === me?.user.id);
  const needsYou = openTasks.filter(needsMe);
  const rest = openTasks.filter((t) => !needsMe(t));
  const emplioOn = rest.filter((t) => !t.assigneeId);
  const comingUp = rest.filter((t) => !!t.assigneeId);
  // done this week, latest first (a search looks through all of them)
  const finished = all
    .filter((t) => !isOpen(t) && (words.length > 0 || new Date(t.doneAt ?? t.createdAt).getTime() > endOfToday - WEEK))
    .sort((a, b) => (b.doneAt ?? b.createdAt).localeCompare(a.doneAt ?? a.createdAt));
  const current = tasks.data?.find((t) => t.id === openId) ?? null;
  // done asks first, then offers an undo for a few seconds; reopening a done one needs neither
  const toggle = (t: Task) => {
    if (!isOpen(t)) return update.mutate({ id: t.id, status: "todo" });
    confirm({
      title: "Mark this done?",
      description: <>&ldquo;{t.title}&rdquo;</>,
      action: "Mark done",
      safe: true,
      onConfirm: () => {
        update.mutate({ id: t.id, status: "done" });
        toast("Marked done", { description: t.title, action: { label: "Undo", onClick: () => update.mutate({ id: t.id, status: t.status }) } });
      },
    });
  };

  const row = (t: Task) => (
    <li key={t.id} className="group flex items-start gap-3 px-2 py-2.5 hover:bg-muted/50 sm:rounded-lg">
      <button
        type="button"
        onClick={() => toggle(t)}
        aria-label={isOpen(t) ? `Mark "${t.title}" done` : `Reopen "${t.title}"`}
        className={cn(
          "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border-2 transition-colors",
          isOpen(t) ? "border-muted-foreground/40 hover:border-primary hover:bg-primary/10" : "border-primary bg-primary text-primary-foreground",
        )}
      >
        <CheckIcon className={cn("size-3", isOpen(t) && "opacity-0 group-hover:opacity-40")} strokeWidth={3} />
      </button>
      <button type="button" onClick={() => setOpenId(t.id)} className="grid min-w-0 flex-1 gap-1 text-left">
        <span className="flex items-start gap-2">
          <span className={cn("min-w-0 flex-1 text-sm font-medium", !isOpen(t) && "text-muted-foreground line-through")}>
            {t.title}
          </span>
          <StatusPill status={t.status} />
        </span>
        {(t.notes || t.waitingOn) && (
          <span className="truncate text-xs text-muted-foreground">
            {t.waitingOn ? `Waiting on ${t.waitingOn}` : t.notes}
          </span>
        )}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Person t={t} />
          <Due t={t} />
          {t.requesterName && t.requesterId !== t.assigneeId && (
            <span className="text-xs text-muted-foreground">asked by {t.requesterName}</span>
          )}
        </span>
      </button>
      {/* Emplio stopped for their word: answer where it asked */}
      {!t.assigneeId && t.status === "waiting" && (
        <Button size="sm" variant="outline" className="shrink-0" nativeButton={false} render={<Link href={`/chat/${t.workConversationId ?? t.conversationId ?? ""}`} />}>
          Answer
        </Button>
      )}
    </li>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <h1 className="px-2 font-sans text-sm font-medium tracking-normal">Work</h1>
        <div className="ml-auto flex items-center gap-2">
          <Select items={SHOW} value={show} onValueChange={(v) => v && setShow(v)}>
            <SelectTrigger size="sm" aria-label="Whose tasks" className="w-28 sm:w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SHOW.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <div className="under-tabs min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-4 px-4 py-4 sm:gap-6 sm:py-6">
          <QuickAdd people={people} />

          <div className="flex shrink-0 items-center gap-2">
            <InputGroup className="h-8 flex-1">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks" aria-label="Search tasks" />
              {query && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" onClick={() => setQuery("")} aria-label="Clear search">
                    <XIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
          </div>

          {tasks.isPending ? (
            <div className="grid gap-3">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
              {[
                { label: "Needs you", items: needsYou },
                { label: "Emplio is on it", items: emplioOn },
                { label: "Coming up", items: comingUp },
              ].filter((g) => g.items.length).map((g) => (
                <section key={g.label} className="grid gap-1">
                  <h2
                    className={cn(
                      "px-2 font-sans text-xs font-medium tracking-normal text-muted-foreground",
                      g.label === "Needs you" && "text-amber-700 dark:text-amber-300",
                    )}
                  >
                    {g.label} <span className="font-normal">{g.items.length}</span>
                  </h2>
                  <ul className="divide-y sm:divide-y-0">{g.items.map(row)}</ul>
                </section>
              ))}
              {!words.length && <Repeating />}
              {!openTasks.length && words.length > 0 && (
                <p className="py-12 text-center text-sm text-muted-foreground">No open tasks match &ldquo;{query.trim()}&rdquo;.</p>
              )}
              {!openTasks.length && !words.length && (
                <div className="grid justify-items-center gap-2 py-12 text-center">
                  <span className="grid size-12 place-items-center rounded-full bg-muted">
                    <ClipboardListIcon className="size-5 text-muted-foreground" />
                  </span>
                  <p className="text-sm font-medium">Nothing to do</p>
                  <p className="max-w-xs text-sm text-muted-foreground">
                    Add a task above, or just tell Emplio in a chat, like &quot;remind Raj to send the quote by
                    Friday&quot;.
                  </p>
                </div>
              )}
              {!!finished.length && (
                <section className="grid gap-1">
                  <button
                    type="button"
                    onClick={() => setShowDone(!showDone)}
                    className="flex items-center gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <ChevronRightIcon className={cn("size-3.5 transition-transform", showDone && "rotate-90")} />
                    {words.length ? "Done" : "Done this week"} <span className="font-normal">{finished.length}</span>
                  </button>
                  {showDone && <ul className="divide-y sm:divide-y-0">{finished.slice(0, 50).map(row)}</ul>}
                </section>
              )}
            </div>
          )}
        </div>
      </div>

      <Sheet open={!!current} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full gap-0 sm:max-w-md">
          {current && (
            <TaskDetails
              key={current.id}
              t={current}
              people={people}
              onChange={(body) => update.mutate({ id: current.id, ...body })}
              onRemove={() =>
                confirm({
                  title: "Delete this task?",
                  description: <>&ldquo;{current.title}&rdquo; will be deleted for everyone. To keep a record, mark it cancelled instead.</>,
                  onConfirm: () => remove.mutate(current.id),
                })
              }
              onStart={() => start.mutate(current.id)}
              starting={start.isPending}
              error={update.error?.message ?? start.error?.message ?? remove.error?.message}
            />
          )}
        </SheetContent>
      </Sheet>
      {confirmDialog}
    </div>
  );
}

type People = { value: string; label: string }[];

function WhoSelect({ people, value, onChange, className }: { people: People; value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <Select items={people} value={value} onValueChange={(v) => v && onChange(v)}>
      <SelectTrigger aria-label="Who does it" className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {people.map((p) => (
          <SelectItem key={p.value} value={p.value}>
            {p.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// The add box: type what's to be done, Enter. Who and when are optional (default: the AI, no date).
function QuickAdd({ people }: { people: People }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [who, setWho] = useState(AI);
  const [due, setDue] = useState("");
  const add = useMutation({
    mutationFn: (body: TaskInput) => api<Task>("/tasks", body),
    onSuccess: (task) => {
      setTitle("");
      setDue("");
      queryClient.setQueryData<Task[]>(tasksQueryKey, (old) => [...(old ?? []), task]);
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    },
  });
  return (
    <form
      className="grid gap-2 rounded-xl border bg-background p-2 shadow-xs focus-within:ring-2 focus-within:ring-ring/30"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) add.mutate({ title, assigneeId: who === AI ? null : who, dueAt: due || null });
      }}
    >
      <div className="flex items-center gap-2 px-1">
        <PlusIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          aria-label="New task"
          placeholder="Add a task, e.g. Send Acme the revised quote"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <WhoSelect people={people} value={who} onChange={setWho} className="h-8 min-w-0 flex-1 sm:w-44 sm:flex-none" />
        <Input type="date" aria-label="Due" value={due} onChange={(e) => setDue(e.target.value)} className="h-8 min-w-0 flex-1 sm:w-40 sm:flex-none" />
        <Button type="submit" size="sm" className="ml-auto" disabled={add.isPending || !title.trim()}>
          Add task
        </Button>
      </div>
      {add.error && <p className="px-1 text-sm text-destructive">{add.error.message}</p>}
    </form>
  );
}

// One task, every field editable; text fields save when you leave them.
function TaskDetails({
  t,
  people,
  onChange,
  onRemove,
  onStart,
  starting,
  error,
}: {
  t: Task;
  people: People;
  onChange: (body: TaskInput) => void;
  onRemove: () => void;
  onStart: () => void;
  starting: boolean;
  error?: string;
}) {
  const [title, setTitle] = useState(t.title);
  const [notes, setNotes] = useState(t.notes ?? "");
  const [waiting, setWaiting] = useState(t.waitingOn ?? "");
  const created = new Date(t.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return (
    <>
      <SheetHeader className="gap-1 border-b pr-12">
        <SheetTitle className="sr-only">Task</SheetTitle>
        <textarea
          aria-label="Title"
          value={title}
          rows={1}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title.trim() !== t.title && onChange({ title })}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())}
          className="field-sizing-content resize-none bg-transparent font-heading text-lg font-semibold outline-none"
        />
        <SheetDescription>
          {t.requesterName ? `Asked by ${t.requesterName}` : "Added"} on {created}
          {t.chases > 0 && ` · reminded ${t.chases} time${t.chases === 1 ? "" : "s"}`}
        </SheetDescription>
      </SheetHeader>

      <div className="grid flex-1 content-start gap-4 overflow-y-auto p-4">
        {!t.assigneeId && t.running && (
          <div className="flex items-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
            <Spinner className="size-4" />
            Emplio is working on this now.
          </div>
        )}
        <div className="grid grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-3">
          <Label className="text-muted-foreground">Status</Label>
          <Select items={STATUS} value={t.status} onValueChange={(v) => v && onChange({ status: v as TaskStatus })}>
            <SelectTrigger aria-label="Status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label className="text-muted-foreground">Who</Label>
          <WhoSelect
            people={people}
            value={t.assigneeId ?? AI}
            onChange={(v) => onChange({ assigneeId: v === AI ? null : v })}
            className="w-full"
          />
          <Label htmlFor="task-due" className="text-muted-foreground">
            Due
          </Label>
          <Input
            id="task-due"
            type="date"
            value={dateOf(t.dueAt)}
            onChange={(e) => onChange({ dueAt: e.target.value || null })}
          />
          {(t.status === "waiting" || t.waitingOn) && (
            <>
              <Label htmlFor="task-waiting" className="text-muted-foreground">
                Waiting on
              </Label>
              <Input
                id="task-waiting"
                placeholder="e.g. Acme's purchase order"
                value={waiting}
                onChange={(e) => setWaiting(e.target.value)}
                onBlur={() => waiting !== (t.waitingOn ?? "") && onChange({ waitingOn: waiting || null })}
              />
            </>
          )}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="task-notes" className="text-muted-foreground">
            How to do it
          </Label>
          <Textarea
            id="task-notes"
            placeholder="Steps, links, or which way it's usually done"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== (t.notes ?? "") && onChange({ notes: notes || null })}
            className="min-h-32"
          />
        </div>

        {(t.conversationId || t.workConversationId) && (
          <div className="flex flex-wrap gap-2">
            {t.workConversationId && (
              <Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/chat/${t.workConversationId}`} />}>
                <BotIcon />
                See the AI&apos;s work on it
              </Button>
            )}
            {/* picked up in the chat it came from: one link does for both */}
            {t.conversationId && t.conversationId !== t.workConversationId && (
              <Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/chat/${t.conversationId}`} />}>
                <MessageSquareIcon />
                The chat it came from
              </Button>
            )}
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <SheetFooter className="flex-row items-center border-t">
        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onRemove}>
          <Trash2Icon />
          Delete
        </Button>
        {!t.assigneeId && (t.status === "todo" || t.status === "waiting") && (
          <Button size="sm" className="ml-auto" onClick={onStart} disabled={starting}>
            <PlayIcon />
            Start now
          </Button>
        )}
        <Button
          size="sm"
          className={cn(!(!t.assigneeId && (t.status === "todo" || t.status === "waiting")) && "ml-auto")}
          variant={isOpen(t) && t.assigneeId ? "default" : "outline"}
          onClick={() => {
            onChange({ status: isOpen(t) ? "done" : "todo" });
            if (isOpen(t)) toast("Marked done", { description: t.title, action: { label: "Undo", onClick: () => onChange({ status: t.status }) } });
          }}
        >
          <CheckIcon />
          {isOpen(t) ? "Mark done" : "Reopen"}
        </Button>
      </SheetFooter>
    </>
  );
}

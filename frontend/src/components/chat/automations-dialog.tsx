"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Automation, AutomationRun } from "@emplio/shared";
import {
  ArrowLeftIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/confirm";
import { Textarea } from "@/components/ui/textarea";
import { api, useMe } from "@/lib/api";

const automationsQueryKey = ["automations"];

const when = (a: Automation) =>
  a.when === "trigger"
    ? `When ${a.trigger}`
    : a.when === "schedule"
      ? `Schedule ${a.schedule} (${a.timezone})`
      : a.when === "new client"
        ? "For each new client"
        : "Run by hand";

const at = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const RUN_LABEL: Record<AutomationRun["status"], string> = {
  running: "running",
  done: "done",
  failed: "failed",
};

// The business's automations: what starts each one, who it runs as, its last run (and that run's chat).
// The owner and admins can add, edit, run, pause and delete them; each is a file in company/automations/.
export function AutomationsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: me } = useMe();
  const canManage = !!me && me.workspaces[0]?.role !== "member";
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: automationsQueryKey,
    queryFn: () => api<Automation[]>("/automations"),
    enabled: open,
    // runs started by schedules and app events show up on their own
    refetchInterval: open ? 10_000 : false,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: automationsQueryKey });
  // null: the list; "": a new one; a name: editing that one
  const [editing, setEditing] = useState<string | null>(null);
  // an automation whose runs are shown
  const [runsOf, setRunsOf] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (a: Automation) =>
      api(`/automations/${a.name}`, { enabled: !a.enabled }, "PATCH"),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (name: string) =>
      api(`/automations/${name}`, undefined, "DELETE"),
    onSettled: refresh,
  });
  const run = useMutation({
    mutationFn: (name: string) =>
      api(`/automations/${name}/run`, undefined, "POST"),
    onSettled: refresh,
  });
  // which of what it lists its runs may do without asking
  const allow = useMutation({
    mutationFn: ({ a, action, on }: { a: Automation; action: string; on: boolean }) =>
      api(`/automations/${a.name}/allowed`, { allowed: a.actions.filter((x) => (x.action === action ? on : x.allowed)).map((x) => x.action) }, "PUT"),
    onSettled: refresh,
  });
  const error = toggle.error ?? remove.error ?? run.error ?? allow.error;
  const [confirmDialog, confirm] = useConfirm();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setEditing(null);
          setRunsOf(null);
        }
      }}
    >
      <DialogContent className="flex h-[min(720px,88dvh)] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="gap-1 border-b px-5 pt-5 pb-3">
          <DialogTitle>Automations</DialogTitle>
          <DialogDescription>
            Work Emplio does on its own: on a schedule, when something
            happens in an app, or when you run it. Each run gets its own chat,
            kept here under its automation. You can also set them up by asking
            in chat.
          </DialogDescription>
        </DialogHeader>

        {runsOf !== null ? (
          <Runs
            name={runsOf}
            onBack={() => setRunsOf(null)}
            onOpen={() => onOpenChange(false)}
          />
        ) : editing !== null ? (
          <Editor
            name={editing}
            onDone={() => {
              setEditing(null);
              void refresh();
            }}
          />
        ) : list.isPending ? (
          <div className="grid gap-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : !list.data?.length ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="grid size-12 place-items-center rounded-full bg-muted">
              <ZapIcon className="size-5 text-muted-foreground" />
            </div>
            <div>
              <div className="text-sm font-medium">No automations yet</div>
              <div className="text-sm text-muted-foreground">
                Try asking in chat: &quot;every weekday at 9, send me
                yesterday&apos;s sales&quot;.
              </div>
            </div>
            {canManage && (
              <Button onClick={() => setEditing("")}>
                <PlusIcon />
                New automation
              </Button>
            )}
          </div>
        ) : (
          <>
            <ul className="flex-1 divide-y overflow-y-auto px-5">
              {list.data.map((a) => (
                <li key={a.name} className="flex items-start gap-3 py-3">
                  <span
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${
                      a.error
                        ? "bg-destructive"
                        : a.enabled
                          ? "bg-emerald-500"
                          : "bg-muted-foreground/40"
                    }`}
                    aria-label={
                      a.error ? "Can't run" : a.enabled ? "On" : "Off"
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {a.name}
                      {!a.enabled && (
                        <span className="font-normal text-muted-foreground">
                          {" "}
                          (off)
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {when(a)} · runs as {a.owner?.name ?? "nobody"}
                    </div>
                    <div className="line-clamp-2 text-xs text-muted-foreground">
                      {a.prompt}
                    </div>
                    {/* what its runs send or change: each needs allowing once, the rest is refused */}
                    <div className="mt-2 flex flex-col gap-1.5">
                      {a.actions.length ? (
                        a.actions.map((x) => (
                          <label key={x.action} className="flex min-w-0 items-center gap-2 text-xs">
                            <Switch
                              size="sm"
                              checked={x.allowed}
                              disabled={!canManage || allow.isPending}
                              onCheckedChange={(on) => allow.mutate({ a, action: x.action, on })}
                              aria-label={`Allow ${x.title}`}
                            />
                            {/* eslint-disable-next-line @next/next/no-img-element -- app logos from the provider */}
                            {x.logo && <img src={x.logo} alt="" className="size-3.5 shrink-0 rounded-sm" />}
                            <span className="truncate">
                              {x.title} <span className="text-muted-foreground">· {x.app}</span>
                            </span>
                            {!x.allowed && <span className="shrink-0 text-amber-600 dark:text-amber-400">needs your OK</span>}
                          </label>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">Only reads: it can&apos;t send or change anything.</span>
                      )}
                    </div>
                    {a.error && (
                      <div className="mt-1 text-xs text-destructive">
                        Can&apos;t run: {a.error}
                      </div>
                    )}
                    <div className="mt-1 text-xs text-muted-foreground">
                      {a.lastRun ? (
                        <>
                          Last run {at(a.lastRun.startedAt)},{" "}
                          {RUN_LABEL[a.lastRun.status]}
                          {" · "}
                          <button
                            type="button"
                            onClick={() => setRunsOf(a.name)}
                            className="underline underline-offset-2 hover:text-foreground"
                          >
                            see runs
                          </button>
                        </>
                      ) : (
                        "Never run"
                      )}
                      {a.nextRunAt && ` · next ${at(a.nextRunAt)}`}
                    </div>
                  </div>
                  {canManage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={`Manage ${a.name}`}
                          />
                        }
                      >
                        <MoreHorizontalIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => run.mutate(a.name)}>
                          Run now
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toggle.mutate(a)}>
                          {a.enabled ? "Turn off" : "Turn on"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setEditing(a.name)}>
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() =>
                            confirm({
                              title: `Delete “${a.name}”?`,
                              description: "It stops running. Its past runs stay in the activity log.",
                              onConfirm: () => remove.mutate(a.name),
                            })
                          }
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              ))}
            </ul>
            {(canManage || error) && (
              <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
                <p className="text-sm text-destructive">{error?.message}</p>
                {canManage && (
                  <Button variant="outline" onClick={() => setEditing("")}>
                    <PlusIcon />
                    New automation
                  </Button>
                )}
              </div>
            )}
          </>
        )}
        {confirmDialog}
      </DialogContent>
    </Dialog>
  );
}

// One automation's runs, newest first, each opening the chat it ran in.
function Runs({
  name,
  onBack,
  onOpen,
}: {
  name: string;
  onBack: () => void;
  onOpen: () => void;
}) {
  const runs = useQuery({
    queryKey: ["automation-runs", name],
    queryFn: () =>
      api<AutomationRun[]>(
        `/automation-runs?name=${encodeURIComponent(name)}&limit=100`,
      ),
    refetchInterval: 10_000,
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-5 pt-4 pb-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Back to the list"
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="truncate text-sm font-medium">{name}: runs</div>
      </div>
      {runs.isPending ? (
        <div className="grid gap-3 p-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : !runs.data?.length ? (
        <p className="p-5 text-sm text-muted-foreground">Never run.</p>
      ) : (
        <ul className="flex-1 divide-y overflow-y-auto px-5">
          {runs.data.map((r) => (
            <li key={r.id} className="flex items-center gap-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div>
                  {at(r.startedAt)}{" "}
                  <span className="text-muted-foreground">
                    · {r.reason === "manual" ? "run by hand" : r.reason} ·{" "}
                    {RUN_LABEL[r.status]}
                  </span>
                </div>
                {r.error && (
                  <div className="truncate text-xs text-destructive">
                    {r.error}
                  </div>
                )}
              </div>
              {r.conversationId && (
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={
                    <Link href={`/chat/${r.conversationId}`} onClick={onOpen} />
                  }
                >
                  Open chat
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type When = Automation["when"];
type Fields = {
  when: When;
  trigger: string;
  config: Record<string, unknown>;
  schedule: string;
  timezone: string;
  enabled: boolean;
  prompt: string;
  // the file's other settings (clients:, process:, who:, actions:, ...), kept as written
  rest: string[];
};

const BLANK: Fields = {
  when: "schedule",
  trigger: "",
  config: {},
  schedule: "0 9 * * 1-5",
  // the person's own clock (the browser's)
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  enabled: true,
  prompt: "",
  rest: [],
};

// the header lines (and their indented ones) the form doesn't edit
const FORM_KEYS = ["when", "trigger", "config", "schedule", "timezone", "enabled"];
const restOf = (text: string) => {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  let keep = false;
  return head.split(/\r?\n/).filter((l) => {
    if (!/^\s/.test(l)) keep = !FORM_KEYS.includes(l.split(":")[0]!.trim());
    return keep;
  });
};

const WHEN_LABEL: Record<When, string> = {
  schedule: "On a schedule",
  trigger: "When something happens in an app",
  manual: "Only when run by hand",
  "new client": "For each new client",
};

// Back to the file the server stores. JSON strings and objects are valid YAML, so no YAML library.
// ponytail: comments in a hand-written file are dropped on save
const toFile = (f: Fields) => {
  const q = JSON.stringify;
  const lines = ["---", `when: ${f.when}`];
  if (f.when === "trigger") {
    lines.push(`trigger: ${q(f.trigger)}`);
    const config = Object.entries(f.config).filter(([, v]) => v !== "");
    if (config.length)
      lines.push("config:", ...config.map(([k, v]) => `  ${k}: ${q(v)}`));
  }
  if (f.when === "schedule")
    lines.push(`schedule: ${q(f.schedule)}`, `timezone: ${q(f.timezone)}`);
  lines.push(...f.rest, `enabled: ${f.enabled}`, "---", f.prompt.trim(), "");
  return lines.join("\n");
};

// The automation as a form: what starts it, its settings, and the instructions. name "": a new one.
function Editor({ name, onDone }: { name: string; onDone: () => void }) {
  const file = useQuery({
    queryKey: ["automation", name],
    queryFn: () =>
      api<{
        text: string;
        error?: string;
        when?: When;
        trigger?: string | null;
        triggerConfig?: Record<string, unknown> | null;
        schedule?: string | null;
        timezone?: string | null;
        enabled?: boolean;
        prompt?: string;
      }>(`/automations/${name}`),
    enabled: !!name,
  });
  const [newName, setNewName] = useState("");
  const [edits, setEdits] = useState<Partial<Fields>>({});
  const d = file.data;
  const loaded: Fields =
    d && !d.error
      ? {
          when: d.when!,
          trigger: d.trigger ?? "",
          config: d.triggerConfig ?? {},
          schedule: d.schedule ?? BLANK.schedule,
          timezone: d.timezone ?? BLANK.timezone,
          enabled: d.enabled ?? true,
          prompt: d.prompt ?? "",
          rest: restOf(d.text),
        }
      : BLANK;
  const f = { ...loaded, ...edits };
  const set = (patch: Partial<Fields>) => setEdits((e) => ({ ...e, ...patch }));
  const save = useMutation({
    mutationFn: () =>
      api<Automation>(
        `/automations/${name || newName}`,
        { text: toFile(f) },
        "PUT",
      ),
    onSuccess: onDone,
  });

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex items-center gap-2 px-5 pt-4">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label="Back to the list"
          onClick={onDone}
        >
          <ArrowLeftIcon />
        </Button>
        {name ? (
          <div className="truncate text-sm font-medium">{name}</div>
        ) : (
          <Input
            required
            pattern="[a-z0-9][a-z0-9\-]*"
            title="lowercase letters, digits and dashes"
            placeholder="name, like daily-sales-summary"
            aria-label="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value.toLowerCase())}
          />
        )}
        <label className="ml-auto flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={f.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          On
        </label>
      </div>

      {name && file.isPending ? (
        <div className="grid gap-3 p-5">
          <Skeleton className="h-16" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-5">
          {d?.error && (
            <p className="text-sm text-destructive">
              This file couldn&apos;t be read ({d.error}); saving replaces it.
            </p>
          )}
          <section className="grid gap-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase">
              Runs
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(WHEN_LABEL) as When[]).map((w) => (
                <Button
                  key={w}
                  type="button"
                  size="sm"
                  variant={f.when === w ? "default" : "outline"}
                  aria-pressed={f.when === w}
                  onClick={() => set({ when: w })}
                >
                  {WHEN_LABEL[w]}
                </Button>
              ))}
            </div>
            {f.when === "trigger" && (
              <div className="grid gap-3 rounded-lg border p-3">
                <label className="grid gap-1 text-sm">
                  <span className="text-muted-foreground">App event</span>
                  <Input
                    required
                    className="font-mono text-xs"
                    placeholder="gmail.new_gmail_message"
                    value={f.trigger}
                    onChange={(e) => set({ trigger: e.target.value })}
                  />
                </label>
                {Object.entries(f.config).map(([k, v]) => (
                  <label key={k} className="grid gap-1 text-sm">
                    <span className="text-muted-foreground">
                      {k === "query" ? "Only emails matching" : k}
                    </span>
                    <Input
                      className="font-mono text-xs"
                      value={typeof v === "string" ? v : JSON.stringify(v)}
                      onChange={(e) =>
                        set({ config: { ...f.config, [k]: e.target.value } })
                      }
                    />
                  </label>
                ))}
                <p className="text-xs text-muted-foreground">
                  Ask in chat to find the right event and its settings.
                </p>
              </div>
            )}
            {f.when === "schedule" && (
              <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  <span className="text-muted-foreground">
                    When (minute hour day month weekday)
                  </span>
                  <Input
                    required
                    className="font-mono text-xs"
                    value={f.schedule}
                    onChange={(e) => set({ schedule: e.target.value })}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="text-muted-foreground">Time zone</span>
                  <Input
                    required
                    value={f.timezone}
                    onChange={(e) => set({ timezone: e.target.value })}
                  />
                </label>
              </div>
            )}
          </section>
          <section className="grid gap-2">
            <h3 className="text-xs font-medium text-muted-foreground uppercase">
              Instructions
            </h3>
            <Textarea
              required
              aria-label="Instructions"
              placeholder="What to do each time, as you'd tell a new employee."
              className="min-h-56 text-sm"
              value={f.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
            />
          </section>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t px-5 py-3">
        <p className="text-sm text-destructive">{save.error?.message}</p>
        <Button type="submit" disabled={save.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

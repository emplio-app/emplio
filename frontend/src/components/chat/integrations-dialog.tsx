"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  APP_CATEGORIES,
  type AppCategory,
  type AppInfo,
  type Connection,
  type McpServer,
} from "@emplio/shared";
import { MoreHorizontalIcon, PlugIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";
import {
  AppLogo,
  ConnectButton,
  ConnectedMark,
  connectionsQueryKey,
  useConnect,
  useConnections,
} from "@/components/chat/connect-card";
import { Button } from "@/components/ui/button";
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
import { useConfirm } from "@/components/confirm";
import { McpTab } from "@/components/chat/mcp-tab";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";

const STATUS: Record<Connection["status"], { label: string; dot: string }> = {
  active: { label: "Connected", dot: "bg-emerald-500" },
  pending: { label: "Sign-in not finished", dot: "bg-amber-500" },
  expired: {
    label: "Expired, reconnect to keep using it",
    dot: "bg-destructive",
  },
  failed: { label: "Sign-in failed", dot: "bg-destructive" },
};

const since = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

// This person's accounts (rename, reconnect, disconnect) and every app that can be connected, by search
// or category; an app can have several accounts (work and personal Gmail).
export function IntegrationsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const connections = useConnections(open);
  const [current, setTab] = useState<"browse" | "mine" | "mcp">("browse");
  // the tabs' counts, from the same lists the tabs load, so each is fetched once
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api<AppInfo[]>("/apps"), enabled: open, staleTime: 60_000 });
  const mcp = useQuery({ queryKey: ["mcp"], queryFn: () => api<{ servers: McpServer[]; canEdit: boolean }>("/mcp"), enabled: open });
  const counted = (label: string, count = 0) => (count ? `${label} · ${count}` : label);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(720px,88dvh)] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="gap-1 px-5 pt-5 pb-3">
          <DialogTitle>Integrations</DialogTitle>
          <DialogDescription>
            Apps Emplio can use for you. They&apos;re yours: only your
            chats use them.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 border-b px-5" role="tablist">
          {(
            [
              ["browse", counted("Browse", apps.data?.length)],
              ["mine", counted("My connections", connections.data?.length)],
              ["mcp", counted("MCP", mcp.data?.servers.length)],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={current === key}
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-2 pb-2 text-sm font-medium transition-colors ${
                current === key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {current === "mcp" ? (
          <McpTab />
        ) : current === "mine" ? (
          <YourApps
            connections={connections.data}
            loading={connections.isPending}
            onBrowse={() => setTab("browse")}
          />
        ) : (
          <Browse open={open} connections={connections.data} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function YourApps({
  connections,
  loading,
  onBrowse,
}: {
  connections?: Connection[];
  loading: boolean;
  onBrowse: () => void;
}) {
  const queryClient = useQueryClient();
  const { connect, connecting, keyDialog } = useConnect();
  const remove = useMutation({
    mutationFn: (id: string) => api(`/connections/${id}`, undefined, "DELETE"),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: connectionsQueryKey }),
  });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDialog, confirm] = useConfirm();
  const rename = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      api(`/connections/${id}`, { label }, "PATCH"),
    onSuccess: () => setRenaming(null),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: connectionsQueryKey }),
  });

  if (loading) return <RowSkeletons />;
  if (!connections?.length)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="grid size-12 place-items-center rounded-full bg-muted">
          <PlugIcon className="size-5 text-muted-foreground" />
        </div>
        <div>
          <div className="text-sm font-medium">No apps connected yet</div>
          <div className="text-sm text-muted-foreground">
            Connect Gmail, Calendar, Zoho and more so Emplio can work
            in them.
          </div>
        </div>
        <Button onClick={onBrowse}>Browse apps</Button>
      </div>
    );

  return (
    <>
      <ul className="flex-1 divide-y overflow-y-auto px-5">
        {connections.map((c) => (
          <li key={c.id} className="flex items-center gap-3 py-3">
            <AppLogo src={c.logo} />
            <div className="min-w-0 flex-1">
              {renaming === c.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const label = new FormData(e.currentTarget).get("label");
                    rename.mutate({ id: c.id, label: String(label) });
                  }}
                >
                  <Input
                    name="label"
                    defaultValue={c.label}
                    autoFocus
                    maxLength={80}
                    aria-label={`Name for this ${c.name} account`}
                    className="h-7 text-sm"
                    onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setRenaming(null))}
                    onBlur={(e) =>
                      e.currentTarget.value.trim() && e.currentTarget.value !== c.label
                        ? rename.mutate({ id: c.id, label: e.currentTarget.value })
                        : setRenaming(null)
                    }
                  />
                  {rename.error && (
                    <p className="pt-1 text-xs text-destructive">{rename.error.message}</p>
                  )}
                </form>
              ) : (
                <div className="truncate text-sm font-medium">
                  {c.name}
                  {c.label !== c.name && (
                    <span className="font-normal text-muted-foreground"> · {c.label}</span>
                  )}
                </div>
              )}
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className={`size-1.5 shrink-0 rounded-full ${c.problem ? "bg-destructive" : STATUS[c.status].dot}`}
                />
                {/* why it isn't working, when known: permissions left out, a sign-in that stopped working */}
                <span className={c.problem ? "line-clamp-2 text-destructive" : "truncate"}>
                  {c.problem ?? STATUS[c.status].label}
                  {c.status === "active" && !c.problem && ` · since ${since(c.createdAt)}`}
                </span>
              </div>
            </div>
            {(c.status !== "active" || c.problem) && (
              <ConnectButton
                busy={connecting === c.id}
                onClick={() => connect({ ...c, connection: c.id })}
                label="Reconnect"
              />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={`Manage ${c.name}`}
                  />
                }
              >
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    rename.reset();
                    setRenaming(c.id);
                  }}
                >
                  Rename
                </DropdownMenuItem>
                {c.status === "active" && !c.problem && (
                  <DropdownMenuItem onClick={() => connect({ ...c, connection: c.id })}>
                    Reconnect
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => connect({ ...c, connection: undefined })}>
                  Add another {c.name} account
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() =>
                    confirm({
                      title: `Disconnect ${c.name}?`,
                      description: "Emplio won't be able to use this account any more. Automations that need it will stop working.",
                      action: "Disconnect",
                      onConfirm: () => remove.mutate(c.id),
                    })
                  }
                >
                  Disconnect
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
      {keyDialog}
      {confirmDialog}
    </>
  );
}

function Browse({
  open,
  connections,
}: {
  open: boolean;
  connections?: Connection[];
}) {
  const { connect, connecting, keyDialog } = useConnect();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<AppCategory | null>(null);
  // the apps we offer: a short list, so it's loaded once and filtered here as you type
  const apps = useQuery({
    queryKey: ["apps"],
    queryFn: () => api<AppInfo[]>("/apps"),
    enabled: open,
    staleTime: 60_000,
  });
  // app -> how many accounts are connected
  const active = new Map<string, number>();
  for (const c of connections ?? [])
    if (c.status === "active") active.set(c.app, (active.get(c.app) ?? 0) + 1);
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  const list = (apps.data ?? []).filter(
    (a) =>
      (!category || a.category === category) &&
      terms.every((t) =>
        `${a.name} ${a.description}`.toLowerCase().includes(t),
      ),
  );
  // only categories that have an app
  const categories = APP_CATEGORIES.filter((c) =>
    apps.data?.some((a) => a.category === c.key),
  );

  const chip = (selected: boolean) =>
    `shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
      selected
        ? "border-primary bg-primary text-primary-foreground"
        : "bg-background text-muted-foreground hover:text-foreground"
    }`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid gap-3 px-5 pt-4 pb-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search apps"
            aria-label="Search apps"
            autoFocus
            className="h-10 pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="-mx-5 flex gap-1.5 overflow-x-auto px-5 pb-1 [scrollbar-width:none]">
          <button
            type="button"
            className={chip(!category)}
            onClick={() => setCategory(null)}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c.key}
              type="button"
              className={chip(category === c.key)}
              onClick={() => setCategory(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-5 pb-5">
        {apps.isPending ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-[76px] rounded-xl" />
            ))}
          </div>
        ) : apps.error ? (
          <p className="py-6 text-center text-sm text-destructive">
            {apps.error.message}
          </p>
        ) : !list.length ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No app matches{search && ` "${search}"`}.
          </p>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              {list.map((a) => (
                <div
                  key={a.app}
                  className="flex items-start gap-3 rounded-xl border bg-card p-3"
                >
                  <AppLogo src={a.logo} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{a.name}</div>
                    <div className="line-clamp-2 text-xs text-muted-foreground">
                      {a.description}
                    </div>
                    {active.has(a.app) && (
                      <div className="flex items-center gap-2 pt-1">
                        <ConnectedMark
                          count={active.get(a.app)}
                        />
                        <button
                          type="button"
                          onClick={() => connect(a)}
                          disabled={connecting === a.app}
                          className="inline-flex items-center gap-0.5 whitespace-nowrap text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-70"
                        >
                          <PlusIcon className="size-3" />
                          {connecting === a.app ? "Waiting…" : "Add another"}
                        </button>
                      </div>
                    )}
                  </div>
                  {active.has(a.app) ? null : (
                    <ConnectButton
                      busy={connecting === a.app}
                      onClick={() => connect(a)}
                    />
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {keyDialog}
    </div>
  );
}

const RowSkeletons = () => (
  <div className="flex-1 px-5 py-3">
    {Array.from({ length: 4 }, (_, i) => (
      <div key={i} className="flex items-center gap-3 py-3">
        <Skeleton className="size-10 rounded-lg" />
        <div className="grid flex-1 gap-1.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-48" />
        </div>
      </div>
    ))}
  </div>
);

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AddMemberRequest, AgentInfo, TeamMember } from "@emplio/shared";
import { BotIcon, ChevronRightIcon, MoreHorizontalIcon, SearchIcon, UserPlusIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "@/components/ui/combobox";
import { useConfirm } from "@/components/confirm";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { api, useMe } from "@/lib/api";

const teamQueryKey = ["team"];
const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Staff" } as const;

// Who does the work here: the people (the owner and admins can add people, who get an email, change roles,
// set who reports to whom, optional, and remove them) and Emplio's agents (read-only).
export function TeamPage() {
  const open = true;
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const team = useQuery({
    queryKey: teamQueryKey,
    queryFn: () => api<TeamMember[]>("/team"),
    enabled: open,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: teamQueryKey });

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [admin, setAdmin] = useState(false);
  const add = useMutation({
    mutationFn: (body: AddMemberRequest) => api<TeamMember>("/team", body),
    onSuccess: () => {
      setEmail("");
      setName("");
      setAdmin(false);
      setAdding(false);
      void refresh();
    },
  });
  const change = useMutation({
    mutationFn: ({ id, role }: { id: string; role: "admin" | "member" }) => api(`/team/${id}`, { role }, "PATCH"),
    onSettled: refresh,
  });
  const lead = useMutation({
    mutationFn: ({ id, reportsTo }: { id: string; reportsTo: string | null }) => api(`/team/${id}`, { reportsTo }, "PATCH"),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/team/${id}`, undefined, "DELETE"),
    onSettled: refresh,
  });

  const [confirmDialog, confirm] = useConfirm();
  const [adding, setAdding] = useState(false);
  // a big team: find people by name or email, and pick a manager by typing rather than from a long menu
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState<string | null>(null);
  const label = (m: TeamMember) => m.name ?? m.email;
  const q = query.trim().toLowerCase();
  const shown = (team.data ?? []).filter((m) => !q || `${m.name ?? ""} ${m.email}`.toLowerCase().includes(q));
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<AgentInfo[]>("/agents"), enabled: open });
  const agentsShown = (agents.data ?? []).filter((a) => !q || `${a.name} ${a.description} ${a.skills.join(" ")}`.toLowerCase().includes(q));
  // a big team: one section at a time, or both with the first few of each
  const [view, setView] = useState<"all" | "people" | "agents">("all");
  const FEW = 6;
  const limit = (n: number) => (view === "all" ? Math.min(n, FEW) : n);

  const myRole = me?.workspaces[0]?.role;
  const canManage = myRole === "owner" || myRole === "admin";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <h1 className="px-2 font-sans text-sm font-medium tracking-normal">Team</h1>
        <div className="ml-auto flex items-center gap-2">
          {canManage && (
            <Button size="sm" className="gap-1.5" onClick={() => setAdding(true)} aria-label="Add person">
              <UserPlusIcon className="size-3.5" /> <span className="hidden sm:inline">Add person</span>
            </Button>
          )}
        </div>
      </header>
      <div className="under-tabs min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-10 px-4 py-6 sm:py-8">
          <div className="-mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <nav className="flex flex-wrap items-center gap-1" aria-label="Show">
              {(
                [
                  ["all", "Everyone", (team.data?.length ?? 0) + (agents.data?.length ?? 0)],
                  ["people", "People", team.data?.length ?? 0],
                  ["agents", "Agents", agents.data?.length ?? 0],
                ] as const
              ).map(([v, l, n]) => (
                <Button key={v} size="sm" variant={view === v ? "secondary" : "ghost"} onClick={() => setView(v)}>
                  {l} <span className="text-muted-foreground">{n}</span>
                </Button>
              ))}
            </nav>
            <InputGroup className="h-8 w-full sm:ml-auto sm:w-56">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the team"
                aria-label="Search the team"
              />
            </InputGroup>
          </div>
          {view !== "agents" && (
            <section className="grid grid-cols-[minmax(0,1fr)] gap-3">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h2 className="font-sans text-base font-medium tracking-normal">
                    People <span className="font-normal text-muted-foreground">{team.data?.length ?? ""}</span>
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Everyone here can chat with Emplio. Staff can&apos;t see restricted files or change skills.
                  </p>
                </div>
              </div>
              {team.isPending ? (
                <div className="grid gap-2">
                  {Array.from({ length: 3 }, (_, i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              ) : (
                <ul className="divide-y overflow-hidden rounded-xl border bg-card">
                  {q && !shown.length && <li className="px-4 py-3 text-sm text-muted-foreground">Nobody matches.</li>}
                  {shown.slice(0, limit(shown.length)).map((m) => (
                    <li key={m.id} className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                          {initials(label(m))}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">
                            {m.name ?? m.email}
                            {m.id === me?.user.id && <span className="font-normal text-muted-foreground"> (you)</span>}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {[
                              m.name && m.email,
                              m.reportsTo &&
                                `reports to ${(() => {
                                  const l = team.data?.find((x) => x.id === m.reportsTo);
                                  return l ? label(l) : "someone";
                                })()}`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </div>
                        <Badge variant={m.role === "member" ? "outline" : "secondary"}>{ROLE_LABEL[m.role]}</Badge>
                        {canManage && m.role !== "owner" && m.id !== me?.user.id && (
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={<Button variant="ghost" size="icon" className="size-7" aria-label={`Manage ${m.name ?? m.email}`} />}
                            >
                              <MoreHorizontalIcon />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() =>
                                  change.mutate({
                                    id: m.id,
                                    role: m.role === "admin" ? "member" : "admin",
                                  })
                                }
                              >
                                {m.role === "admin" ? "Make staff" : "Make admin"}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setPicking(m.id)}>
                                {m.reportsTo ? "Change who they report to" : "Set who they report to"}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() =>
                                  confirm({
                                    title: `Remove ${m.name ?? m.email}?`,
                                    description: "They lose access to Emplio and this business. You can invite them again later.",
                                    action: "Remove",
                                    onConfirm: () => remove.mutate(m.id),
                                  })
                                }
                              >
                                Remove from team
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                      {picking === m.id && (
                        <Combobox
                          items={[null, ...(team.data ?? []).filter((x) => x.id !== m.id)]}
                          value={team.data?.find((x) => x.id === m.reportsTo) ?? null}
                          itemToStringLabel={(x: TeamMember | null) => (x ? label(x) : "No one")}
                          isItemEqualToValue={(a: TeamMember | null, b: TeamMember | null) => a?.id === b?.id}
                          defaultOpen
                          onOpenChange={(open) => !open && setPicking(null)}
                          onValueChange={(x: TeamMember | null) => {
                            if ((x?.id ?? null) !== m.reportsTo) lead.mutate({ id: m.id, reportsTo: x?.id ?? null });
                            setPicking(null);
                          }}
                        >
                          <ComboboxInput autoFocus className="mt-3 w-full" placeholder={`Who does ${label(m)} report to?`} />
                          <ComboboxContent className="min-w-(--anchor-width)">
                            <ComboboxEmpty>Nobody matches.</ComboboxEmpty>
                            <ComboboxList>
                              {(x: TeamMember | null) => (
                                <ComboboxItem key={x?.id ?? "none"} value={x}>
                                  {x ? (
                                    <span className="grid">
                                      <span>{label(x)}</span>
                                      {x.name && <span className="text-xs text-muted-foreground">{x.email}</span>}
                                    </span>
                                  ) : (
                                    "No one"
                                  )}
                                </ComboboxItem>
                              )}
                            </ComboboxList>
                          </ComboboxContent>
                        </Combobox>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {shown.length > limit(shown.length) && (
                <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setView("people")}>
                  Show all {shown.length} people
                </Button>
              )}
              {lead.error && <p className="text-sm text-destructive">{lead.error.message}</p>}
            </section>
          )}

          {view !== "people" && (
            <section className="grid grid-cols-[minmax(0,1fr)] gap-3">
              <div>
                <h2 className="font-sans text-base font-medium tracking-normal">Emplio&apos;s agents</h2>
                <p className="text-sm text-muted-foreground">
                  Specialists Emplio hands work to. It sets them up and keeps them up to date; to change one, tell Emplio in the chat.
                </p>
              </div>
              <Agents list={agents.isPending ? undefined : agentsShown} searching={!!q} limit={limit(agentsShown.length)} />
              {agentsShown.length > limit(agentsShown.length) && (
                <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setView("agents")}>
                  Show all {agentsShown.length} agents
                </Button>
              )}
            </section>
          )}
        </div>
      </div>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add someone</DialogTitle>
            <DialogDescription>They get an email to join, and can chat with Emplio right away.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate({
                email,
                name: name || undefined,
                role: admin ? "admin" : "member",
              });
            }}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                type="email"
                required
                placeholder="Email"
                aria-label="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Input placeholder="Full name" aria-label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
                Admin (sees restricted files, can manage the team)
              </label>
              <Button type="submit" disabled={add.isPending}>
                Add and email
              </Button>
            </div>
            {add.error && <p className="text-sm text-destructive">{add.error.message}</p>}
          </form>
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </div>
  );
}

// Emplio's agents: read-only rows, opened for what each does, its skills and what it has learned. Emplio
// makes, improves and retires them as it works; changing one is a word in chat.
function Agents({ list, searching, limit }: { list: AgentInfo[] | undefined; searching: boolean; limit: number }) {
  const [shown, setShown] = useState<string | null>(null);
  if (!list)
    return (
      <div className="grid gap-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  if (!list.length)
    return searching ? (
      <p className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">No agent matches.</p>
    ) : (
      <div className="grid justify-items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-muted">
          <BotIcon className="size-5 text-muted-foreground" />
        </span>
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          When a kind of work keeps coming back, Emplio sets up an agent for it, like a Supplier Finder or an Invoice Chaser, and hands it
          that work from then on.
        </p>
      </div>
    );
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {list.slice(0, limit).map((a) => {
        const open = shown === a.slug;
        return (
          <li key={a.slug}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setShown(open ? null : a.slug)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
                <BotIcon className="size-4 text-muted-foreground" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{a.name}</span>
                <span className={cn("block text-xs text-muted-foreground", !open && "truncate")}>{a.description}</span>
              </span>
              {!!a.lessons.length && (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                  {a.lessons.length} {a.lessons.length === 1 ? "lesson" : "lessons"}
                </span>
              )}
              <ChevronRightIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
            </button>
            {open && (
              <div className="grid gap-3 px-4 pb-4 pl-16 text-xs text-muted-foreground">
                {!!a.skills.length && (
                  <div className="grid gap-1.5">
                    <span className="font-medium text-foreground">Skills it uses</span>
                    <span className="flex flex-wrap gap-1.5">
                      {a.skills.map((k) => (
                        <Badge key={k} variant="secondary">
                          {k.replace(/-/g, " ")}
                        </Badge>
                      ))}
                    </span>
                  </div>
                )}
                <div className="grid gap-1.5">
                  <span className="font-medium text-foreground">What it has learned</span>
                  {a.lessons.length ? (
                    <ul className="grid list-disc gap-1 pl-4">
                      {a.lessons.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  ) : (
                    <span>Nothing yet.</span>
                  )}
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

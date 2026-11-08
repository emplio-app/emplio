"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JobSummary } from "@emplio/shared";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BlocksIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  ClipboardListIcon,
  ChevronDownIcon,
  CircleHelpIcon,
  XIcon,
  KeyRoundIcon,
  LogOutIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  Trash2Icon,
  UsersIcon,
  ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useDraft } from "@/components/chat/draft";
import { AutomationsDialog } from "@/components/chat/automations-dialog";
import { ChannelNudge, ChannelsDialog } from "@/components/chat/channels-dialog";
import { BillingMenuItem, CreditMeter } from "@cloud/client";
import { SearchResults } from "@/components/chat/chat-search";
import { IntegrationsDialog } from "@/components/chat/integrations-dialog";
import { SettingsDialog } from "@/components/chat/settings-dialog";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { useConfirm } from "@/components/confirm";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  api,
  conversationsQueryKey,
  meQueryKey,
  useConversations,
  useTasks,
  useLiveEvents,
  useMe,
  useArchiveConversation,
  useRenameConversation,
} from "@/lib/api";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export function AppSidebar() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const { data: conversations } = useConversations();
  const { data: me } = useMe();
  const { data: tasks } = useTasks();
  // mine that are due today or late: the count beside Tasks
  const endOfToday = new Date().setHours(24, 0, 0, 0);
  const dueNow = tasks?.filter(
    (t) =>
      t.assigneeId === me?.user.id &&
      t.status !== "done" &&
      t.status !== "cancelled" &&
      t.dueAt &&
      new Date(t.dueAt).getTime() < endOfToday,
  ).length;
  // the AI's tasks that stopped for a look from whoever asked (backend tasks.ts): waiting on me
  const waitingOnMe = tasks?.filter((t) => t.status === "waiting" && !t.assigneeId && t.requesterId === me?.user.id).length;
  useLiveEvents();
  // jobs opened as their own chat, nested under the chat they came from until closed (their line there still opens them)
  const { data: jobs } = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<JobSummary[]>("/jobs"),
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === "working") ? 3000 : false),
  });
  // chats whose jobs are folded away
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const toggleFold = (id: string) =>
    setFolded((old) => {
      const next = new Set(old);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const { newDraft } = useDraft();
  const closeJob = useMutation({
    mutationFn: (id: string) => api(`/jobs/${id}/close`, {}),
    onSuccess: (_, id) => {
      if (pathname === `/chat/${jobs?.find((j) => j.id === id)?.chatId}`) router.push("/home");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const closeSearch = () => {
    setSearch("");
    setSearching(false);
  };
  const router = useRouter();
  const queryClient = useQueryClient();

  // the main chat is Chat, at the top (the same one as on their phone); the person's other chats below it
  const main = conversations?.find((c) => c.kind === "main");
  const others = conversations?.filter((c) => !c.archived && c.kind !== "main") ?? [];
  const archived = conversations?.filter((c) => c.archived) ?? [];
  const [shown, setShown] = useState(10);
  const [showArchived, setShowArchived] = useState(false);
  const listed = [...others.slice(0, shown), ...(showArchived ? archived : [])];
  // a job nests under its chat; one whose chat isn't listed (an automation's, or further down) under the main chat
  const jobsUnder = (id: string) => jobs?.filter((j) => j.startedIn === id) ?? [];
  const mainJobs = jobs?.filter((j) => !listed.some((c) => c.id === j.startedIn)) ?? [];
  const [confirmDialog, confirm] = useConfirm();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // right-clicking a chat opens its menu, like the ⋯ button
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const rename = useRenameConversation();
  const archive = useArchiveConversation();
  const remove = useMutation({
    mutationFn: (id: string) => api(`/conversations/${id}`, undefined, "DELETE"),
    onSuccess: (_, id) => {
      if (pathname === `/chat/${id}`) router.push("/home");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: conversationsQueryKey });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
  const jobRows = (list: JobSummary[]) => (
    <JobRows jobs={list} pathname={pathname} onOpen={() => setOpenMobile(false)} onClose={(id) => closeJob.mutate(id)} />
  );

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="gap-3 px-3 pt-4">
        <div className="px-1">
          <Logo href={main ? `/chat/${main.id}` : "/home"} onClick={() => setOpenMobile(false)} />
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={!!main && pathname === `/chat/${main.id}`}
              render={
                <Link href={main ? `/chat/${main.id}` : "/home"} onClick={() => setOpenMobile(false)} />
              }
              className="h-9 font-medium"
            >
              <MessageCircleIcon />
              Chat
              {main?.channel === "telegram" && (
                <SendIcon className="size-3.5 shrink-0 text-[#229ED9]" aria-label="Also on Telegram" />
              )}
            </SidebarMenuButton>
            {!!main && !!mainJobs.length && (
              <SidebarMenuAction
                onClick={() => toggleFold(main.id)}
                aria-expanded={!folded.has(main.id)}
                aria-label={folded.has(main.id) ? "Show opened work" : "Hide opened work"}
                className="text-muted-foreground peer-data-[size=default]/menu-button:top-2"
              >
                <ChevronDownIcon className={cn("transition-transform", folded.has(main.id) && "-rotate-90")} />
              </SidebarMenuAction>
            )}
            {main && (main.running || (main.unread && pathname !== `/chat/${main.id}`)) && (
              <SidebarMenuBadge className={cn("peer-data-[size=default]/menu-button:top-2", !!mainJobs.length && "right-7")}>
                {main.running ? (
                  <Spinner className="size-3.5 text-muted-foreground" aria-label="Working" />
                ) : (
                  <span className="size-2 rounded-full bg-primary" aria-label="New message" />
                )}
              </SidebarMenuBadge>
            )}
            {!!main && !!mainJobs.length && !folded.has(main.id) && jobRows(mainJobs)}
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname.startsWith("/tasks")}
              render={
                <Link href="/tasks" onClick={() => setOpenMobile(false)} />
              }
              className="h-9 font-medium"
            >
              <ClipboardListIcon />
              Work
            </SidebarMenuButton>
            {(!!dueNow || !!waitingOnMe) && (
              <SidebarMenuBadge className="gap-1 px-0 peer-data-[size=default]/menu-button:top-2">
                {!!waitingOnMe && (
                  <span
                    title={`${waitingOnMe} waiting on you`}
                    className="grid h-5 min-w-5 place-items-center rounded-md bg-amber-500/15 px-1 text-amber-700 dark:text-amber-300"
                  >
                    {waitingOnMe}
                  </span>
                )}
                {!!dueNow && (
                  <span
                    title={`${dueNow} due today or late`}
                    className="grid h-5 min-w-5 place-items-center rounded-md bg-primary px-1 text-primary-foreground"
                  >
                    {dueNow}
                  </span>
                )}
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname.startsWith("/knowledge") || pathname.startsWith("/files") || pathname.startsWith("/database")}
              render={
                <Link href="/knowledge" onClick={() => setOpenMobile(false)} />
              }
              className="h-9 font-medium"
            >
              <BookOpenIcon />
              Memory
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* the people here and Emplio's agents: who does the work */}
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname.startsWith("/team")}
              render={<Link href="/team" onClick={() => setOpenMobile(false)} />}
              className="h-9 font-medium"
            >
              <UsersIcon />
              Team
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="px-1">
        <SidebarGroup className="pb-0">
          <SidebarGroupLabel>Chats</SidebarGroupLabel>
          <SidebarMenu>
          {/* New chat, with search one tap away: the tap turns this row into the search box until it's closed */}
          <SidebarMenuItem className={cn("relative flex gap-1", searching && "mb-2")}>
            {searching ? (
              <>
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  autoFocus
                  aria-label="Search your chats"
                  placeholder="Search chats"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onBlur={() => !search.trim() && closeSearch()}
                  onKeyDown={(e) => e.key === "Escape" && closeSearch()}
                  className="h-9 w-full rounded-md bg-background pr-8 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                />
                <button
                  type="button"
                  aria-label="Close search"
                  title="Close search"
                  onClick={closeSearch}
                  className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <XIcon className="size-4" />
                </button>
              </>
            ) : (
              <>
                <SidebarMenuButton
                  render={
                    <Link
                      href="/chat"
                      onClick={() => {
                        newDraft();
                        setOpenMobile(false);
                      }}
                    />
                  }
                  className="h-9 w-auto min-w-0 flex-1 font-medium"
                >
                  <PlusIcon />
                  New chat
                </SidebarMenuButton>
                <SidebarMenuButton
                  onClick={() => setSearching(true)}
                  aria-label="Search chats"
                  title="Search chats"
                  className="size-9 shrink-0 justify-center p-0 text-muted-foreground"
                >
                  <SearchIcon />
                </SidebarMenuButton>
              </>
            )}
          </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        {search.trim() ? (
          <SearchResults query={search} onOpen={() => setOpenMobile(false)} />
        ) : (
          <SidebarGroup className="pt-0">
            <SidebarMenu>
              {listed.map((c) => {
                const under = jobsUnder(c.id);
                return (
                  <SidebarMenuItem key={c.id}>
                    {renamingId === c.id ? (
                      <RenameInput
                        className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                        initial={c.title}
                        onDone={(title) => {
                          setRenamingId(null);
                          if (title && title !== c.title) rename.mutate({ id: c.id, title });
                        }}
                      />
                    ) : (
                      <>
                        <SidebarMenuButton
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setMenuFor(c.id);
                          }}
                          isActive={pathname === `/chat/${c.id}`}
                          render={<Link href={`/chat/${c.id}`} onClick={() => setOpenMobile(false)} />}
                          // relative: the spinner centres on this row, not on the row plus its jobs below
                          className={cn("relative", !!under.length && "pr-14")}
                        >
                          <span className="truncate">{c.title}</span>
                          {/* in the options button's spot (hidden until hover) */}
                          {(c.running || (c.unread && pathname !== `/chat/${c.id}`)) && (
                            <span className="absolute top-1/2 right-1 grid w-5 -translate-y-1/2 place-items-center group-hover/menu-item:invisible">
                              {c.running ? (
                                <Spinner className="size-3.5 text-muted-foreground" aria-label="Working" />
                              ) : (
                                <span className="size-2 rounded-full bg-primary" aria-label="New reply" />
                              )}
                            </span>
                          )}
                        </SidebarMenuButton>
                        {!!under.length && (
                          <SidebarMenuAction
                            onClick={() => toggleFold(c.id)}
                            aria-expanded={!folded.has(c.id)}
                            aria-label={folded.has(c.id) ? "Show opened work" : "Hide opened work"}
                            className="right-7 text-muted-foreground"
                          >
                            <ChevronDownIcon className={cn("transition-transform", folded.has(c.id) && "-rotate-90")} />
                          </SidebarMenuAction>
                        )}
                        <DropdownMenu open={menuFor === c.id} onOpenChange={(open) => setMenuFor(open ? c.id : null)}>
                          <DropdownMenuTrigger render={<SidebarMenuAction showOnHover aria-label="Chat options" />}>
                            <MoreHorizontalIcon />
                          </DropdownMenuTrigger>
                          {/* no focus back to the trigger on close: it would steal focus from the rename box and end it at once */}
                          <DropdownMenuContent side="right" align="start" className="w-40" finalFocus={false}>
                            <DropdownMenuItem onClick={() => setRenamingId(c.id)}>
                              <PencilIcon />
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => archive.mutate({ id: c.id, archived: !c.archived })}>
                              {c.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                              {c.archived ? "Unarchive" : "Archive"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() =>
                                confirm({
                                  title: "Delete this chat?",
                                  description: <>&ldquo;{c.title}&rdquo; and all its messages will be permanently deleted.</>,
                                  onConfirm: () => remove.mutate(c.id),
                                })
                              }
                            >
                              <Trash2Icon />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        {!!under.length && !folded.has(c.id) && jobRows(under)}
                      </>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
            {others.length > shown && (
              <button
                type="button"
                onClick={() => setShown((n) => n + 20)}
                className="mt-1 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
              >
                Show {Math.min(20, others.length - shown)} more
              </button>
            )}
            {!!archived.length && (
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className="rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
              >
                {showArchived ? "Hide archived" : `Archived (${archived.length})`}
              </button>
            )}
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="p-3">
        <CreditMeter />
        <ChannelNudge />
        <UserMenu />
      </SidebarFooter>
      <SidebarRail />
      {confirmDialog}
    </Sidebar>
  );
}

// A chat's opened jobs: a tree line down to each with a tick into it, the last one curving in
function JobRows({ jobs, pathname, onOpen, onClose }: { jobs: JobSummary[]; pathname: string; onOpen: () => void; onClose: (id: string) => void }) {
  return (
    <SidebarMenuSub className="mt-0.5 mr-0 gap-0.5 border-l-0 pr-0">
      {jobs.map((j) => (
        <SidebarMenuSubItem
          key={j.id}
          className="group/job relative before:absolute before:top-0 before:-left-2.5 before:h-[calc(100%+2px)] before:w-px before:bg-sidebar-border last:before:h-1/2 last:before:w-2 last:before:rounded-bl-md last:before:border-b last:before:border-l last:before:border-sidebar-border last:before:bg-transparent not-last:after:absolute not-last:after:top-1/2 not-last:after:-left-2.5 not-last:after:h-px not-last:after:w-2 not-last:after:bg-sidebar-border"
        >
          <SidebarMenuSubButton
            isActive={pathname === `/chat/${j.chatId}`}
            render={<Link href={`/chat/${j.chatId}`} onClick={onOpen} />}
            title={j.agent ? `${j.agent}: ${j.name}` : j.name}
            className="w-full"
          >
            <span className="truncate">{j.name}</span>
            {j.status === "working" ? (
              <Spinner className="ml-auto size-3 shrink-0 text-muted-foreground" aria-label="Working" />
            ) : j.status === "asking" ? (
              <CircleHelpIcon className="ml-auto size-3 shrink-0 text-amber-500" aria-label="Has a question" />
            ) : j.status === "failed" ? (
              <XIcon className="ml-auto size-3 shrink-0 text-destructive" aria-label="Failed" />
            ) : null}
          </SidebarMenuSubButton>
          <button
            type="button"
            aria-label={`Close ${j.name}`}
            title="Close"
            onClick={() => onClose(j.id)}
            className="absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded-md bg-sidebar-accent text-muted-foreground opacity-0 outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/job:opacity-100 pointer-coarse:opacity-100"
          >
            <XIcon className="size-3" />
          </button>
        </SidebarMenuSubItem>
      ))}
    </SidebarMenuSub>
  );
}

export function RenameInput({
  initial,
  onDone,
  className,
}: {
  initial: string;
  onDone: (title: string) => void;
  className?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      aria-label="Chat title"
      maxLength={80}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => onDone(value.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") onDone(initial);
      }}
      className={cn(
        "outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
    />
  );
}

function UserMenu() {
  const { data: me } = useMe();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  // everything on screen belongs to the business that was open
  const reopen = async () => {
    await queryClient.resetQueries();
    router.push("/home");
  };
  const open = useMutation({
    mutationFn: (id: string) => api(`/workspaces/${id}/open`, {}),
    onSuccess: reopen,
  });
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", {}),
    onSuccess: () => {
      router.replace("/");
      queryClient.clear();
    },
  });
  if (!me) return null;
  const initials = (me.user.name ?? me.user.email)
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton
              size="lg"
              className="data-popup-open:bg-sidebar-accent"
            />
          }
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-xs font-semibold text-primary">
            {initials}
          </span>
          <span className="grid min-w-0 flex-1 text-left leading-tight">
            <span className="truncate text-sm font-medium">{me.user.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {me.workspaces[0]?.name}
            </span>
          </span>
          <ChevronsUpDownIcon className="ml-auto size-4 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          className="w-(--anchor-width) min-w-56"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal">
              <div className="text-sm font-medium text-foreground">
                {me.user.name}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {me.user.email}
              </div>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Business
            </DropdownMenuLabel>
            {me.workspaces.map((w, i) => (
              <DropdownMenuItem
                key={w.id}
                onClick={() => i > 0 && open.mutate(w.id)}
                disabled={open.isPending}
              >
                <span className="truncate">{w.name}</span>
                {i === 0 && <CheckIcon className="ml-auto" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onClick={() => setNewOpen(true)}>
              <PlusIcon />
              New business
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAppsOpen(true)}>
            <BlocksIcon />
            Integrations
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setAutomationsOpen(true)}>
            <ZapIcon />
            Automations
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setChannelsOpen(true)}>
            <MessageCircleIcon />
            Channels
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/logins")}>
            <KeyRoundIcon />
            Passwords & keys
          </DropdownMenuItem>
          <BillingMenuItem role={me.workspaces[0]?.role} />
          <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
            <SettingsIcon />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            <LogOutIcon />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <IntegrationsDialog open={appsOpen} onOpenChange={setAppsOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ChannelsDialog open={channelsOpen} onOpenChange={setChannelsOpen} />
      <AutomationsDialog
        open={automationsOpen}
        onOpenChange={setAutomationsOpen}
      />
      <NewBusinessDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={async () => {
          // the new business first (the welcome page renames it), then straight there; the rest reloads meanwhile
          await queryClient.refetchQueries({ queryKey: meQueryKey });
          router.push("/welcome");
          void queryClient.resetQueries();
        }}
      />
    </>
  );
}

function NewBusinessDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api("/workspaces", { name }),
    onSuccess: async () => {
      onOpenChange(false);
      setName("");
      await onCreated();
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New business</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Input
            autoFocus
            placeholder="Business name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
          />
          {create.error && (
            <p className="text-sm text-destructive">{create.error.message}</p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? <Spinner /> : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

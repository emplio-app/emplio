"use client";

import { BookOpenIcon, ClipboardListIcon, MenuIcon, MessageCircleIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSidebar } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { useConversations, useMe, useTasks } from "@/lib/api";
import { cn } from "@/lib/utils";

const TAB = "relative flex min-w-0 flex-col items-center justify-center gap-0.5 text-[0.68rem] font-medium outline-none transition-opacity select-none active:opacity-60 [-webkit-touch-callout:none] [&_svg]:size-5";

// A phone's way around the app, in place of the side menu's button. The menu stays behind More (and a swipe in
// from the edge) for search, usage and the account. Hidden while typing: globals.css .bottom-tabs. It floats
// over the page as frosted glass: lists scroll on underneath it (globals.css .under-tabs).
export function BottomTabs() {
  const pathname = usePathname();
  const { setOpenMobile, openMobile } = useSidebar();
  const { data: conversations } = useConversations();
  const { data: me } = useMe();
  const { data: tasks } = useTasks();
  const main = conversations?.find((c) => c.kind === "main");
  const endOfToday = new Date().setHours(24, 0, 0, 0);
  // what the side menu counts beside Work: waiting on me, and mine due today or late
  const needsMe = tasks?.filter(
    (t) =>
      (t.status === "waiting" && !t.assigneeId && t.requesterId === me?.user.id) ||
      (t.assigneeId === me?.user.id && t.status !== "done" && t.status !== "cancelled" && t.dueAt && new Date(t.dueAt).getTime() < endOfToday),
  ).length;
  const onChat = pathname.startsWith("/chat") || pathname.startsWith("/home");

  const tab = (href: string, label: string, icon: React.ReactNode, active: boolean, mark?: React.ReactNode) => (
    <Link
      href={href}
      onClick={() => setOpenMobile(false)}
      aria-current={active ? "page" : undefined}
      className={cn(TAB, active ? "text-primary" : "text-muted-foreground")}
    >
      <span className="relative">
        {icon}
        {mark && <span className="absolute -top-1 -right-2.5">{mark}</span>}
      </span>
      {label}
    </Link>
  );

  return (
    <nav aria-label="Main" className="bottom-tabs material absolute inset-x-0 bottom-0 z-20 border-t pb-(--safe-bottom) md:hidden">
      <div className="grid h-14 grid-cols-5">
        {tab(
          main ? `/chat/${main.id}` : "/home",
          "Chat",
          <MessageCircleIcon />,
          onChat,
          main?.running ? (
            <Spinner className="size-3" aria-label="Working" />
          ) : main?.unread && !onChat ? (
            <span className="block size-2 rounded-full bg-primary" aria-label="New message" />
          ) : undefined,
        )}
        {tab(
          "/tasks",
          "Work",
          <ClipboardListIcon />,
          pathname.startsWith("/tasks"),
          needsMe ? (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[0.65rem] leading-none text-primary-foreground">{needsMe}</span>
          ) : undefined,
        )}
        {tab("/knowledge", "Memory", <BookOpenIcon />, pathname.startsWith("/knowledge") || pathname.startsWith("/files") || pathname.startsWith("/database"))}
        {tab("/team", "Team", <UsersIcon />, pathname.startsWith("/team"))}
        <button type="button" onClick={() => setOpenMobile(true)} aria-expanded={openMobile} className={cn(TAB, "text-muted-foreground")}>
          <MenuIcon />
          More
        </button>
      </div>
    </nav>
  );
}

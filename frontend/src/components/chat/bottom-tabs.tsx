"use client";

import { BookOpenIcon, ClipboardListIcon, MessageCircleIcon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useSidebar } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { useConversations, useMe, useTasks } from "@/lib/api";
import { haptic } from "@/lib/haptics";
import { cn } from "@/lib/utils";

// the chat last open on this page load, so Chat goes back to it, not to the main chat (#198)
let lastChat: string | undefined;

const TAB = "relative flex min-w-0 flex-col items-center justify-center gap-0.5 text-[0.68rem] font-medium outline-none transition-opacity select-none active:opacity-60 [-webkit-touch-callout:none] [&_svg]:size-5";

// What sits on top of the page (a sheet, a menu, the side menu): the iPhone's own tab bar steps aside for it, and
// Android's back button closes it ((app)/layout.tsx).
export const ON_TOP = '[data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="alert-dialog-content"], [data-slot="sidebar"][data-mobile], [role="menu"], [role="listbox"]';

// The iPhone app's own tab bar (mobile/ios/App/App/AppDelegate.swift TabBarPlugin), Liquid Glass on iOS 26. Missing
// on older app builds and everywhere else, which get the page's own bar below.
type NativeTab = { id: string; title: string; icon: string; badge?: string };
type TabBar = {
  set(o: { tabs: NativeTab[]; selected?: string; visible: boolean }): Promise<{ height: number }>;
  addListener(event: "select", run: (e: { id: string }) => void): { remove(): void } | Promise<{ remove(): void }>;
};
const nativeBar = () =>
  (window as { Capacitor?: { isPluginAvailable?(name: string): boolean; Plugins?: { TabBar?: TabBar } } }).Capacitor?.isPluginAvailable?.("TabBar")
    ? (window as unknown as { Capacitor: { Plugins: { TabBar: TabBar } } }).Capacitor.Plugins.TabBar
    : undefined;

// Shown only on a phone, and not with something open on top. Typing doesn't hide it: the keyboard rises over it and
// falls away from it, as in the iPhone's own apps (hiding it on focus also caught a copy button's brief focus).
function useNativeVisible(bar: TabBar | undefined) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!bar) return;
    const phone = matchMedia("(max-width: 767.98px)");
    const check = () =>
      setVisible(phone.matches && !document.querySelector(ON_TOP));
    check();
    // portals open on the page's body
    const watch = new MutationObserver(check);
    watch.observe(document.body, { childList: true });
    phone.addEventListener("change", check);
    return () => (watch.disconnect(), phone.removeEventListener("change", check));
  }, [bar]);
  return visible;
}

// A phone's way around the app. The side menu (search, usage, the account) opens from the button top left on
// every page (ui/sidebar.tsx SidebarTrigger), or a swipe in from the edge. Hidden while typing: globals.css .bottom-tabs. It floats
// over the page as frosted glass: lists scroll on underneath it (globals.css .under-tabs).
export function BottomTabs() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const { data: conversations } = useConversations();
  const { data: me } = useMe();
  const { data: tasks } = useTasks();
  if (pathname.startsWith("/chat/")) lastChat = pathname.split("/")[2];
  const main = conversations?.find((c) => c.id === lastChat) ?? conversations?.find((c) => c.kind === "main");
  const endOfToday = new Date().setHours(24, 0, 0, 0);
  // what the side menu counts beside Work: waiting on me, and mine due today or late
  const needsMe = tasks?.filter(
    (t) =>
      (t.status === "waiting" && !t.assigneeId && t.requesterId === me?.user.id) ||
      (t.assigneeId === me?.user.id && t.status !== "done" && t.status !== "cancelled" && t.dueAt && new Date(t.dueAt).getTime() < endOfToday),
  ).length;
  const onChat = pathname.startsWith("/chat") || pathname.startsWith("/home");
  const onMemory = pathname.startsWith("/knowledge") || pathname.startsWith("/files") || pathname.startsWith("/database");
  const chatHref = main ? `/chat/${main.id}` : "/home";

  const router = useRouter();
  const [bar] = useState(() => (typeof window === "undefined" ? undefined : nativeBar()));
  const visible = useNativeVisible(bar);
  const hrefs = useRef<Record<string, string>>({});
  // the tab just tapped, until its page has opened: telling the bar the old page meanwhile flicked the selection back
  const [pending, setPending] = useState<string>();
  hrefs.current = { chat: chatHref, work: "/tasks", memory: "/knowledge", team: "/team" };
  useEffect(() => {
    if (!bar) return;
    const listening = bar.addListener("select", ({ id }) => {
      setPending(id);
      setOpenMobile(false);
      if (hrefs.current[id]) router.push(hrefs.current[id]);
    });
    return () => {
      void Promise.resolve(listening).then((h) => h.remove());
    };
  }, [bar, router, setOpenMobile]);
  // leaving the app's pages (signing out): the bar hides, keeping its tabs, so coming back doesn't rebuild them
  useEffect(
    () => () => {
      void bar?.set({ tabs: [], visible: false }).catch(() => {});
      document.documentElement.style.removeProperty("--tabs-h");
    },
    [bar],
  );
  const chatBadge = main?.running || (main?.unread && !onChat) ? "" : undefined;
  const here = onChat ? "chat" : pathname.startsWith("/tasks") ? "work" : onMemory ? "memory" : pathname.startsWith("/team") ? "team" : undefined;
  if (pending && pending === here) setPending(undefined);
  const selected = pending ?? here;
  useEffect(() => {
    if (!bar) return;
    void bar
      .set({
        tabs: [
          { id: "chat", title: "Chat", icon: "message", badge: chatBadge },
          { id: "work", title: "Work", icon: "checklist", badge: needsMe ? String(needsMe) : undefined },
          { id: "memory", title: "Memory", icon: "book", badge: undefined },
          { id: "team", title: "Team", icon: "person.2", badge: undefined },
        ],
        selected,
        visible,
      })
      // the page keeps clear of the bar's real height (globals.css --tabs-h)
      .then(({ height }) => document.documentElement.style.setProperty("--tabs-h", `${height}px`))
      .catch(() => {});
  }, [bar, chatBadge, needsMe, selected, visible]);
  if (bar) return null;

  // tip: what a product tour step points at here (tour.tsx), the icon, ringed round
  const tab = (href: string, label: string, icon: React.ReactNode, active: boolean, mark?: React.ReactNode, tip?: string) => (
    <Link
      href={href}
      onClick={() => {
        if (!active) haptic();
        setOpenMobile(false);
      }}
      aria-current={active ? "page" : undefined}
      className={cn(TAB, active ? "text-primary" : "text-muted-foreground")}
    >
      <span className="relative rounded-full" data-tip={tip}>
        {icon}
        {mark && <span className="absolute -top-1 -right-2.5">{mark}</span>}
      </span>
      {label}
    </Link>
  );

  return (
    <nav aria-label="Main" className="bottom-tabs material absolute inset-x-0 bottom-0 z-20 border-t pb-(--safe-bottom) md:hidden">
      <div className="grid h-14 grid-cols-4">
        {tab(
          chatHref,
          "Chat",
          <MessageCircleIcon />,
          onChat,
          main?.running ? (
            <Spinner className="size-3" aria-label="Working" />
          ) : main?.unread && !onChat ? (
            <span className="block size-2 rounded-full bg-primary" aria-label="New message" />
          ) : undefined,
          "chat-nav",
        )}
        {tab(
          "/tasks",
          "Work",
          <ClipboardListIcon />,
          pathname.startsWith("/tasks"),
          needsMe ? (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[0.65rem] leading-none text-primary-foreground">{needsMe}</span>
          ) : undefined,
          "work",
        )}
        {tab("/knowledge", "Memory", <BookOpenIcon />, onMemory, undefined, "memory")}
        {tab("/team", "Team", <UsersIcon />, pathname.startsWith("/team"), undefined, "team")}
      </div>
    </nav>
  );
}

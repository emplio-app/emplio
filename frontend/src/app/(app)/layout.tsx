"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { AppSidebar } from "@/components/chat/app-sidebar";
import { BottomTabs, ON_TOP } from "@/components/chat/bottom-tabs";
import { JustUpdated, NewVersionBar } from "@/components/chat/new-version";
import { DraftProvider } from "@/components/chat/draft";
import { DesktopHistory } from "@/components/desktop-history";
import { Tour } from "@/components/tour";
import { useDesktopLink } from "@/components/desktop-link";
import { useWebNotifications } from "@/components/web-notifications";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, useMe } from "@/lib/api";
import { haptic } from "@/lib/haptics";
import { hideSplash } from "@/lib/splash";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data: me, isPending } = useMe();

  useEffect(() => {
    // not logged in (or onboarding unfinished, which lives on /login): back here afterwards
    if (!isPending && !me?.user.name) router.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }, [isPending, me, router]);

  // the iPhone app: no arrows-and-Done bar above the keyboard (#282). Mobile Safari keeps it, a web page can't hide it
  useEffect(() => {
    const kb = (window as { Capacitor?: { Plugins?: { Keyboard?: { setAccessoryBarVisible(o: { isVisible: boolean }): Promise<void> } } } })
      .Capacitor?.Plugins?.Keyboard;
    void kb?.setAccessoryBarVisible({ isVisible: false }).catch(() => {});
  }, []);
  usePhoneNotifications(!!me?.user.name, router.push);
  useEffect(() => void (me?.user.name && hideSplash()), [me?.user.name]);
  useAndroidBack();
  useDesktopLink(me?.user.name ? me.user.id : undefined, router.push);
  const notifyBar = useWebNotifications(!!me?.user.name, router.push);

  if (!me?.user.name) return null;

  return (
    <DraftProvider>
      <TooltipProvider>
        <SidebarProvider className="app-frame h-(--app-h) min-h-0 translate-y-(--app-top,0px)">
          <AppSidebar />
          <SidebarInset className="min-w-0 overflow-hidden pt-(--safe-top)">
            <NewVersionBar />
            {notifyBar}
            <JustUpdated />
            {children}
            <BottomTabs />
          </SidebarInset>
        </SidebarProvider>
        {/* last in the page: of two overlapping window-drag areas, the later one wins, and the sidebar's top row is one */}
        <PullToRefresh />
        <DesktopHistory />
        <Tour />
      </TooltipProvider>
    </DraftProvider>
  );
}

// In the phone app (iPhone or Android), once signed in and notifications are allowed: tell the server where to reach this
// phone, and open the chat a tapped notification is about. The plugin is missing on app builds without it.
type PushPlugin = {
  checkPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  addListener(event: string, run: (e: never) => void): { remove(): void } | Promise<{ remove(): void }>;
};
function usePhoneNotifications(signedIn: boolean, open: (path: string) => void) {
  useEffect(() => {
    const push = (window as { Capacitor?: { Plugins?: { PushNotifications?: PushPlugin } } }).Capacitor?.Plugins?.PushNotifications;
    if (!signedIn || !push) return;
    const listening = [
      push.addListener("registration", (t: { value: string }) => void api("/push/device", { token: t.value }).catch(() => {})),
      push.addListener("pushNotificationActionPerformed", (a: { notification: { data?: { path?: string } } }) => {
        if (a.notification.data?.path) open(a.notification.data.path);
      }),
    ];
    // only once allowed: the chat asks after their first job (first-run.tsx Offers), not here at sign-in
    void push.checkPermissions().then((p) => (p.receive === "granted" ? push.register() : undefined));
    return () => void listening.forEach((l) => void Promise.resolve(l).then((h) => h.remove()));
  }, [signedIn, open]);
}

// Android's back button, as its own apps do: closes what's open on top (a sheet, a menu, the side menu), else goes
// back a page, else puts the app away. Without this it left the app from anywhere.
type AppPlugin = {
  addListener(event: "backButton", run: (e: { canGoBack: boolean }) => void): { remove(): void } | Promise<{ remove(): void }>;
  minimizeApp(): Promise<void>;
};
function useAndroidBack() {
  useEffect(() => {
    const cap = (window as { Capacitor?: { getPlatform?(): string; Plugins?: { App?: AppPlugin } } }).Capacitor;
    const app = cap?.Plugins?.App;
    if (cap?.getPlatform?.() !== "android" || !app) return;
    const listening = app.addListener("backButton", ({ canGoBack }) => {
      // Base UI closes the topmost of them on Escape
      if (document.querySelector(ON_TOP)) {
        (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      } else if (canGoBack) history.back();
      else void app.minimizeApp();
    });
    return () => void Promise.resolve(listening).then((h) => h.remove());
  }, []);
}

// Pull a list down from its top to fetch it again, as phone apps do. Not the chat (it fills in by itself, and its
// top is for older messages) and not inside a sheet or the side menu. Moved by hand, no React drawing per frame.
const PULL = 72;
function PullToRefresh() {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const mark = useRef<HTMLDivElement>(null);
  const off = pathname.startsWith("/chat") || pathname.startsWith("/home");
  useEffect(() => {
    const el = mark.current;
    if (off || !el || !matchMedia("(pointer: coarse)").matches) return;
    let startY: number | null = null;
    let pulled = 0;
    let busy = false;
    const place = (y: number, glide: boolean) => {
      el.style.transition = glide ? "transform 250ms cubic-bezier(0.32, 0.72, 0, 1), opacity 250ms" : "none";
      el.style.transform = `translate(-50%, ${y - 48}px) rotate(${y * 4}deg)`;
      el.style.opacity = String(Math.min(1, y / PULL));
    };
    const scroller = (node: EventTarget | null) => {
      for (let box = node instanceof HTMLElement ? node : null; box && box !== document.body; box = box.parentElement) {
        if (box.closest(ON_TOP)) return null;
        if (box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY)) return box;
      }
      return document.body;
    };
    const down = (e: TouchEvent) => {
      const box = scroller(e.target);
      startY = !busy && box && box.scrollTop <= 0 ? e.touches[0]!.clientY : null;
      pulled = 0;
    };
    const move = (e: TouchEvent) => {
      if (startY === null) return;
      const dy = e.touches[0]!.clientY - startY;
      if (dy <= 0) return void (startY = null, place(0, true));
      // harder the further it goes, like a rubber band
      const next = Math.min(PULL * 1.6, dy * 0.5);
      if (pulled < PULL && next >= PULL) haptic();
      pulled = next;
      place(pulled, false);
    };
    const up = async () => {
      if (startY === null) return;
      startY = null;
      if (pulled < PULL) return place(0, true);
      busy = true;
      place(PULL * 0.75, true);
      el.firstElementChild?.classList.add("animate-spin");
      await queryClient.refetchQueries({ type: "active" }).catch(() => {});
      el.firstElementChild?.classList.remove("animate-spin");
      place(0, true);
      busy = false;
    };
    document.addEventListener("touchstart", down, { passive: true });
    document.addEventListener("touchmove", move, { passive: true });
    document.addEventListener("touchend", up);
    document.addEventListener("touchcancel", up);
    return () => {
      document.removeEventListener("touchstart", down);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", up);
      document.removeEventListener("touchcancel", up);
    };
  }, [off, queryClient]);
  if (off) return null;
  return (
    <div
      ref={mark}
      aria-hidden
      className="pointer-events-none fixed top-[calc(var(--safe-top)+0.5rem)] left-1/2 z-30 rounded-full border bg-background p-2 text-muted-foreground opacity-0 shadow-md md:hidden"
      style={{ transform: "translate(-50%, -48px)" }}
    >
      <RefreshCwIcon className="size-5" />
    </div>
  );
}

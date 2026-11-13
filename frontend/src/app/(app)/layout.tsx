"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AppSidebar } from "@/components/chat/app-sidebar";
import { BottomTabs } from "@/components/chat/bottom-tabs";
import { JustUpdated, NewVersionBar } from "@/components/chat/new-version";
import { DraftProvider } from "@/components/chat/draft";
import { DesktopHistory } from "@/components/desktop-history";
import { useDesktopLink } from "@/components/desktop-link";
import { useWebNotifications } from "@/components/web-notifications";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, useMe } from "@/lib/api";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data: me, isPending } = useMe();

  useEffect(() => {
    // not logged in (or onboarding unfinished, which lives on /login): back here afterwards
    if (!isPending && !me?.user.name) router.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }, [isPending, me, router]);

  useFitToScreen();
  usePhoneNotifications(!!me?.user.name, router.push);
  useDesktopLink(me?.user.name ? me.user.id : undefined, router.push);
  const notifyBar = useWebNotifications(!!me?.user.name, router.push);

  if (!me?.user.name) return null;

  return (
    <DraftProvider>
      <TooltipProvider>
        <DesktopHistory />
        <SidebarProvider className="h-(--app-h) min-h-0 translate-y-(--app-top,0px)">
          <AppSidebar />
          <SidebarInset className="min-w-0 overflow-hidden pt-(--safe-top)">
            <NewVersionBar />
            {notifyBar}
            <JustUpdated />
            {children}
            <BottomTabs />
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </DraftProvider>
  );
}

// In the iPhone app, once signed in: ask to notify (iOS only asks once), tell the server where to reach this
// phone, and open the chat a tapped notification is about. The plugin is missing on app builds without it.
type PushPlugin = {
  requestPermissions(): Promise<{ receive: string }>;
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
    void push.requestPermissions().then((p) => (p.receive === "granted" ? push.register() : undefined));
    return () => void listening.forEach((l) => void Promise.resolve(l).then((h) => h.remove()));
  }, [signedIn, open]);
}

// iPhone keyboards cover the page instead of shrinking it, then slide the view up to the field: size the
// app to what's visible and move it along with that slide (--app-top), so the composer sits right above the
// keyboard from the start (scrolling back to the top instead animated, the composer drifting down slowly).
// Only while typing: otherwise Safari's toolbar sliding in and out moved the composer up and down; 100dvh
// covers that.
function useFitToScreen() {
  useEffect(() => {
    const view = window.visualViewport;
    // the desktop app has no on-screen keyboard (and keeps its own top strip): the page stays at its own size
    if (!view || document.documentElement.hasAttribute("data-desktop")) return;
    const root = document.documentElement.style;
    const fit = () => {
      if (view.scale > 1.01) return; // pinch-zoomed: leave the layout alone
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (!typing) return root.removeProperty("--app-h"), root.removeProperty("--app-top");
      root.setProperty("--app-h", `${view.height}px`);
      root.setProperty("--app-top", `${view.offsetTop}px`);
    };
    // Once the keyboard is up, the field being typed in stays in sight: iOS scrolls the page to it, but not a
    // sheet's own scrolling body, which shrank under the keyboard and left the field below its buttons.
    const reveal = () => {
      fit();
      requestAnimationFrame(() => {
        const el = document.activeElement as HTMLElement | null;
        const sheet = el?.closest('[data-slot="dialog-content"], [data-slot="sheet-content"]');
        for (let box = el?.parentElement; el && sheet?.contains(box ?? null); box = box!.parentElement) {
          if (box!.scrollHeight <= box!.clientHeight || !/auto|scroll/.test(getComputedStyle(box!).overflowY)) continue;
          const r = el.getBoundingClientRect();
          const b = box!.getBoundingClientRect();
          if (r.top < b.top || r.height > b.height) box!.scrollTop -= b.top - r.top + 12;
          else if (r.bottom > b.bottom) box!.scrollTop += r.bottom - b.bottom + 12;
          return;
        }
      });
    };
    fit();
    view.addEventListener("resize", reveal);
    view.addEventListener("scroll", fit);
    window.addEventListener("focusin", reveal);
    window.addEventListener("focusout", fit);
    return () => {
      view.removeEventListener("resize", reveal);
      view.removeEventListener("scroll", fit);
      window.removeEventListener("focusin", reveal);
      window.removeEventListener("focusout", fit);
      root.removeProperty("--app-h");
      root.removeProperty("--app-top");
    };
  }, []);
}

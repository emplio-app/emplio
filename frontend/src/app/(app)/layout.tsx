"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AppSidebar } from "@/components/chat/app-sidebar";
import { BottomTabs } from "@/components/chat/bottom-tabs";
import { NewVersionBar } from "@/components/chat/new-version";
import { DraftProvider } from "@/components/chat/draft";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useMe } from "@/lib/api";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data: me, isPending } = useMe();

  useEffect(() => {
    // not logged in (or onboarding unfinished, which lives on /login): back here afterwards
    if (!isPending && !me?.user.name) router.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }, [isPending, me, router]);

  useFitToScreen();

  if (!me?.user.name) return null;

  return (
    <DraftProvider>
      <TooltipProvider>
        <SidebarProvider className="h-(--app-h) min-h-0 translate-y-(--app-top,0px)">
          <AppSidebar />
          <SidebarInset className="min-w-0 overflow-hidden pt-[env(safe-area-inset-top)]">
            <NewVersionBar />
            {children}
            <BottomTabs />
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </DraftProvider>
  );
}

// iPhone keyboards cover the page instead of shrinking it, then slide the view up to the field: size the
// app to what's visible and move it along with that slide (--app-top), so the composer sits right above the
// keyboard from the start (scrolling back to the top instead animated, the composer drifting down slowly).
// Only while typing: otherwise Safari's toolbar sliding in and out moved the composer up and down; 100dvh
// covers that.
function useFitToScreen() {
  useEffect(() => {
    const view = window.visualViewport;
    if (!view) return;
    const root = document.documentElement.style;
    const fit = () => {
      if (view.scale > 1.01) return; // pinch-zoomed: leave the layout alone
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (!typing) return root.removeProperty("--app-h"), root.removeProperty("--app-top");
      root.setProperty("--app-h", `${view.height}px`);
      root.setProperty("--app-top", `${view.offsetTop}px`);
    };
    fit();
    view.addEventListener("resize", fit);
    view.addEventListener("scroll", fit);
    window.addEventListener("focusin", fit);
    window.addEventListener("focusout", fit);
    return () => {
      view.removeEventListener("resize", fit);
      view.removeEventListener("scroll", fit);
      window.removeEventListener("focusin", fit);
      window.removeEventListener("focusout", fit);
      root.removeProperty("--app-h");
      root.removeProperty("--app-top");
    };
  }, []);
}

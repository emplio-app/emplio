"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useAppZoom } from "@/lib/zoom";
import { Analytics } from "@cloud/client";
import { Toaster } from "@/components/ui/sonner";

export function Providers({ children }: { children: React.ReactNode }) {
  // what was fetched counts as fresh for 30s: going back to a page shows it at once instead of fetching it all again.
  // Changes still arrive straight away: the server's events mark what changed as stale (lib/api.ts)
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } }));
  useFitToScreen();
  useAppZoom();
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Analytics />
      <Toaster />
    </QueryClientProvider>
  );
}

// iPhone keyboards cover the page instead of shrinking it, then slide the view up to the field: size the
// app to what's visible and move it along with that slide (--app-top), so the composer sits right above the
// keyboard from the start (scrolling back to the top instead animated, the composer drifting down slowly).
// Only while typing: otherwise Safari's toolbar sliding in and out moved the composer up and down; 100dvh
// covers that.
// The iPhone app (mobile/capacitor.config.js resize "none") instead runs on under the keyboard, which tells the
// page its height the moment it starts to rise: the app shrinks once, right then. The app shrinking itself waited
// for the keyboard to finish plus 0.2s, and left black behind the keyboard's rounded corners.
// On every page, the sign-in included, not just inside the app's frame.
function useFitToScreen() {
  useEffect(() => {
    const view = window.visualViewport;
    const html = document.documentElement;
    const root = html.style;
    let keyboardTells = false;
    // what's typed in: the tab bar makes way (globals.css [data-typing]); a selector watching focus over the whole
    // page cost every tap a full restyle
    const isField = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      (el.isContentEditable ||
        /^(TEXTAREA|SELECT)$/.test(el.tagName) ||
        (el.tagName === "INPUT" && !/^(checkbox|radio|range|file)$/.test((el as HTMLInputElement).type)));
    // In the iPhone app the keyboard itself says so (keyboardUp, clear): a field focused with no keyboard (the hidden
    // one copying text uses) left the tab bar's room taken away, the composer sliding behind the bar
    const focusIn = (e: FocusEvent) => !keyboardTells && html.toggleAttribute("data-typing", isField(e.target));
    // the field taking over, if any; activeElement is already the page itself here. In the iPhone app the keyboard
    // going says so instead (clear), so the tab bar comes back in the same frame the app grows, not a moment
    // before it over the falling keyboard (a flicker on every close)
    const focusOut = (e: FocusEvent) => !keyboardTells && html.toggleAttribute("data-typing", isField(e.relatedTarget));
    window.addEventListener("focusin", focusIn);
    window.addEventListener("focusout", focusOut);
    const clear = () => {
      if (keyboardTells) html.removeAttribute("data-typing");
      root.removeProperty("--keyboard");
      root.removeProperty("--app-h");
      root.removeProperty("--app-top");
    };
    // Once the keyboard is up, the field being typed in stays in sight: iOS scrolls the page to it, but not a
    // sheet's own scrolling body, which shrank under the keyboard and left the field below its buttons.
    const showField = () =>
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

    const keyboardUp = (e: Event) => {
      const height = (e as Event & { keyboardHeight?: number }).keyboardHeight ?? 0;
      html.setAttribute("data-typing", "");
      root.setProperty("--app-h", `${window.innerHeight - height}px`);
      root.setProperty("--app-top", "0px");
      // pages outside the app's frame (sign-in) make room with this
      root.setProperty("--keyboard", `${height}px`);
      showField();
    };
    type Keyboard = { getResizeMode(): Promise<{ mode: string }> };
    const cap = (window as { Capacitor?: { getPlatform?(): string; Plugins?: { Keyboard?: Keyboard } } }).Capacitor;
    // only app builds that leave the resizing to the page: older ones shrink themselves (resize "native")
    if (cap?.getPlatform?.() === "ios")
      void cap.Plugins?.Keyboard?.getResizeMode()
        .then(({ mode }) => {
          if (mode !== "none") return;
          keyboardTells = true;
          // the page's moves glide along with the keyboard (globals.css [data-keyboard-app])
          html.setAttribute("data-keyboard-app", "");
          clear();
          window.addEventListener("keyboardWillShow", keyboardUp);
          window.addEventListener("keyboardWillHide", clear);
        })
        .catch(() => {});

    const fit = () => {
      if (keyboardTells || !view || view.scale > 1.01) return; // pinch-zoomed: leave the layout alone
      if (!isField(document.activeElement)) return clear();
      root.setProperty("--app-h", `${view.height}px`);
      root.setProperty("--app-top", `${view.offsetTop}px`);
    };
    const reveal = () => (fit(), showField());
    // the desktop app has no on-screen keyboard (and keeps its own top strip): the page stays at its own size
    const resizes = !!view && !html.hasAttribute("data-desktop");
    if (resizes) {
      fit();
      view.addEventListener("resize", reveal);
      view.addEventListener("scroll", fit);
      window.addEventListener("focusin", reveal);
      window.addEventListener("focusout", fit);
    }
    return () => {
      window.removeEventListener("focusin", focusIn);
      window.removeEventListener("focusout", focusOut);
      window.removeEventListener("keyboardWillShow", keyboardUp);
      window.removeEventListener("keyboardWillHide", clear);
      if (resizes) {
        view.removeEventListener("resize", reveal);
        view.removeEventListener("scroll", fit);
        window.removeEventListener("focusin", reveal);
        window.removeEventListener("focusout", fit);
      }
      html.removeAttribute("data-typing");
      html.removeAttribute("data-keyboard-app");
      clear();
    };
  }, []);
}

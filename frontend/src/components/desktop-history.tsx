"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";

// The Mac app has no browser bar: back and forward sit next to the window's traffic lights (globals.css leaves room).
export function DesktopHistory() {
  const [mac, setMac] = useState(false);
  const [can, setCan] = useState({ back: true, forward: false });
  useEffect(() => {
    setMac(document.documentElement.getAttribute("data-desktop") === "darwin");
    // ponytail: Chromium's Navigation API knows what is behind and ahead; if it is missing, both stay on
    const nav = (window as { navigation?: { canGoBack: boolean; canGoForward: boolean; addEventListener: Window["addEventListener"]; removeEventListener: Window["removeEventListener"] } }).navigation;
    if (!nav) return setCan({ back: true, forward: true });
    const look = () => setCan({ back: nav.canGoBack, forward: nav.canGoForward });
    look();
    nav.addEventListener("currententrychange", look);
    return () => nav.removeEventListener("currententrychange", look);
  }, []);
  if (!mac) return null;
  const cls = "flex size-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent [-webkit-app-region:no-drag]";
  return (
    <div className="fixed top-[0.845rem] left-[5.5rem] z-50 flex gap-0.5">
      <button type="button" aria-label="Back" disabled={!can.back} onClick={() => history.back()} className={cls}>
        <ChevronLeft className="size-5" />
      </button>
      <button type="button" aria-label="Forward" disabled={!can.forward} onClick={() => history.forward()} className={cls}>
        <ChevronRight className="size-5" />
      </button>
    </div>
  );
}

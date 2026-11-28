"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

// The Mac app has no browser bar: back and forward sit next to the window's traffic lights (globals.css leaves room).
export function DesktopHistory() {
  const [mac, setMac] = useState(false);
  const [can, setCan] = useState({ back: true, forward: false });
  useEffect(() => {
    setMac(document.documentElement.getAttribute("data-desktop") === "darwin");
    // ponytail: Chromium's Navigation API knows what is behind and ahead; if it is missing, both stay on
    const nav = (window as { navigation?: { canGoBack: boolean; canGoForward: boolean; addEventListener: Window["addEventListener"]; removeEventListener: Window["removeEventListener"] } }).navigation;
    if (!nav) return setCan({ back: true, forward: true });
    // later, not at once: Next.js changes the address inside a React insertion effect, where updates aren't allowed
    const look = () => setTimeout(() => setCan({ back: nav.canGoBack, forward: nav.canGoForward }));
    look();
    nav.addEventListener("currententrychange", look);
    return () => nav.removeEventListener("currententrychange", look);
  }, []);
  if (!mac) return null;
  return (
    <div className="fixed top-[0.845rem] left-[5.5rem] z-50 flex gap-0.5">
      <Button variant="ghost" size="icon-sm" aria-label="Back" disabled={!can.back} onClick={() => history.back()} className="text-muted-foreground [-webkit-app-region:no-drag]">
        <ChevronLeft className="size-5" />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Forward" disabled={!can.forward} onClick={() => history.forward()} className="text-muted-foreground [-webkit-app-region:no-drag]">
        <ChevronRight className="size-5" />
      </Button>
    </div>
  );
}

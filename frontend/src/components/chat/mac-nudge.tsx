"use client";

import { DownloadIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { DownloadButton } from "@/components/download-button";
import { useIsMacBrowser } from "@/lib/use-mac-browser";

// In the sidebar, for people on a Mac who haven't got the Mac app. Closing it hides it for a month on this device.
const KEY = "mac-app-nudge-hidden-until";
export function MacNudge() {
  const mac = useIsMacBrowser();
  const [hidden, setHidden] = useState(() => {
    try {
      return Number(localStorage.getItem(KEY)) > Date.now();
    } catch {
      return false;
    }
  });
  if (!mac || hidden) return null;
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(KEY, String(Date.now() + 30 * 24 * 3600_000));
    } catch {}
  };
  return (
    <div className="relative mb-2 rounded-xl border border-primary/25 bg-primary/10 p-3 group-data-[collapsible=icon]:hidden">
      <button type="button" onClick={hide} aria-label="Hide for a month" className="absolute top-2 right-2 rounded p-0.5 text-muted-foreground hover:bg-primary/15 hover:text-foreground">
        <XIcon className="size-3.5" />
      </button>
      <div className="pr-5 text-sm font-medium">Emplio for Mac</div>
      <p className="mt-1 text-xs text-muted-foreground">Faster replies, stronger work.</p>
      <DownloadButton platform="mac" from="sidebar" size="sm" className="mt-2 h-7 w-full">
        <DownloadIcon />
        Download
      </DownloadButton>
    </div>
  );
}

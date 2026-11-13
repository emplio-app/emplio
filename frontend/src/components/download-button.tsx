"use client";

import type { ComponentProps } from "react";
import { track } from "@cloud/client";
import { Button } from "@/components/ui/button";
import { API_URL } from "@/lib/api";

// A Download button for an Emplio desktop app (app/download/[platform]/route.ts sends the file). Each click goes to
// PostHog (`app_downloaded`, on the signed-in person when there is one) and to our database (the cloud's POST /downloads).
// `from`: which button, e.g. "downloads" or "sidebar".
export function DownloadButton({ platform, from, ...props }: { platform: "mac" | "mac-older" | "linux" | "windows"; from: string } & Omit<ComponentProps<typeof Button>, "render" | "nativeButton">) {
  const note = () => {
    track("app_downloaded", { platform, from });
    void fetch(`${API_URL}/downloads`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform, from }) }).catch(() => {});
  };
  return <Button {...props} nativeButton={false} render={<a href={`/download/${platform}`} onClick={note} />} />;
}

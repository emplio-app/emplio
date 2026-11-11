"use client";

import { useQuery } from "@tanstack/react-query";
import type { HealthResponse, Release } from "@emplio/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, versionQueryKey } from "@/lib/api";

// Asked every 5 minutes, when this tab comes back into view, and when the live connection returns after a deploy.
// ponytail: compares with the version this screen first saw, not one stamped at build. A screen that loads in the
// moments between the server and the website restarting misses this update's bar; stamp it at build if that ever bites.
export function NewVersionBar() {
  const { data } = useQuery({
    queryKey: versionQueryKey,
    queryFn: () => api<HealthResponse>("/health"),
    refetchInterval: 5 * 60_000,
  });
  const [mine, setMine] = useState<string>();
  if (data && !mine) setMine(data.version);
  if (!data || !mine || data.version === mine) return null;
  return (
    <div className="flex shrink-0 items-center justify-center gap-3 border-b bg-muted px-4 py-1.5 text-sm">
      A new version of Emplio is ready.
      <Button size="sm" onClick={() => window.location.reload()}>
        Update
      </Button>
    </div>
  );
}

const day = (date: string) => new Date(date).toLocaleDateString(undefined, { dateStyle: "long", timeZone: "UTC" });

function Releases() {
  const { data } = useQuery({ queryKey: ["changelog"], queryFn: () => api<Release[]>("/changelog") });
  if (!data) return <Skeleton className="h-24 w-full" />;
  return (
    <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto">
      {data.map((r) => (
        <section key={r.version}>
          <h3 className="text-sm font-medium">{day(r.date)}</h3>
          <p className="text-xs text-muted-foreground">Version {r.version}</p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-sm">
            {r.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function WhatsNewDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>What&apos;s new</DialogTitle>
          <DialogDescription>The latest changes to Emplio.</DialogDescription>
        </DialogHeader>
        {open && <Releases />}
      </DialogContent>
    </Dialog>
  );
}

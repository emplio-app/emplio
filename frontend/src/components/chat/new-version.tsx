"use client";

import { useQuery } from "@tanstack/react-query";
import type { Change, HealthResponse, Release } from "@emplio/shared";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

const changelogQuery = { queryKey: ["changelog"], queryFn: () => api<Release[]>("/changelog") };

function Releases() {
  const { data } = useQuery(changelogQuery);
  if (!data) return <Skeleton className="h-24 w-full" />;
  return (
    <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto">
      {data.map((r) => (
        <section key={r.version}>
          <h3 className="text-sm font-medium">{day(r.date)}</h3>
          <p className="text-xs text-muted-foreground">Version {r.version}</p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-sm">
            {r.changes.map((change) => (
              <li key={change.text}>
                {change.text}
                {change.image && <img src={change.image} alt="" className="mt-1.5 w-full rounded-md border" />}
              </li>
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

const SEEN = "emplio:seen-version";
const newer = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0;
function remember(version: string) {
  try {
    localStorage.setItem(SEEN, version);
  } catch {}
}

// Once per device after an update: the new changes that come with a picture or GIF, one slide each. Updates with no
// pictures pass quietly, and a device's first visit only notes the version, so new people aren't shown old news.
// ponytail: "seen" lives on the device, so a phone and a laptop each show it once; keep it on the account if that bugs.
export function JustUpdated() {
  const { data } = useQuery(changelogQuery);
  const [card, setCard] = useState<{ version: string; slides: Change[] }>();
  const [i, setI] = useState(0);
  const checked = useRef(false);
  const touchX = useRef(0);

  useEffect(() => {
    // only on load: a refetch while open means the server moved on, and the Update bar handles that
    if (!data || checked.current) return;
    checked.current = true;
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(SEEN);
    } catch {}
    // newest first, at most 10: someone back after many updates gets the latest, not a long queue
    const fresh = seen
      ? data.filter((r) => newer(r.version, seen)).flatMap((r) => r.changes.filter((c) => c.image)).slice(0, 10)
      : [];
    if (fresh.length) setCard({ version: data[0]!.version, slides: fresh });
    else remember(data[0]!.version);
  }, [data]);

  if (!card) return null;
  const { slides } = card;
  const close = () => {
    remember(card.version);
    setCard(undefined);
  };
  const last = i === slides.length - 1;
  const go = (to: number) => setI(Math.max(0, Math.min(slides.length - 1, to)));
  const slide = slides[i]!;

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="sm:max-w-md"
        onTouchStart={(e) => (touchX.current = e.touches[0]!.clientX)}
        onTouchEnd={(e) => {
          const dx = e.changedTouches[0]!.clientX - touchX.current;
          if (Math.abs(dx) > 50) go(i + (dx < 0 ? 1 : -1));
        }}
      >
        <DialogHeader>
          <DialogTitle>Just updated</DialogTitle>
          <DialogDescription>{slides.length > 1 ? `${i + 1} of ${slides.length}` : "Here's what's new."}</DialogDescription>
        </DialogHeader>
        <img key={i} src={slide.image} alt="" className="aspect-video w-full rounded-md border bg-muted object-contain" />
        <p className="text-sm">{slide.text}</p>
        {slides.length > 1 && (
          <div className="flex justify-center gap-1.5">
            {slides.map((s, n) => (
              <span key={s.text} className={`size-1.5 rounded-full ${n === i ? "bg-foreground" : "bg-muted-foreground/30"}`} />
            ))}
          </div>
        )}
        <DialogFooter className="flex-row items-center">
          {!last && (
            <Button variant="ghost" className="mr-auto" onClick={close}>
              Skip
            </Button>
          )}
          {i > 0 && (
            <Button variant="outline" onClick={() => go(i - 1)}>
              Back
            </Button>
          )}
          <Button className={last && i === 0 ? "w-full sm:w-auto" : ""} onClick={last ? close : () => go(i + 1)}>
            {last ? "Got it" : "Next"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

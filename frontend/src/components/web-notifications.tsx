"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const ASKED = "emplio-notify-asked";
const remembered = () => {
  try {
    return localStorage.getItem(ASKED) === "1";
  } catch {
    return false;
  }
};

// Notifications in the browser (public/sw.js shows them, backend/src/push.ts sends them). Not in the iPhone app or the
// desktop app, which have their own. Asked for in a bar the person can say no to, never on page load.
const supported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window &&
  !document.documentElement.hasAttribute("data-desktop") &&
  !(window as { Capacitor?: unknown }).Capacitor;

async function subscribe(key: string) {
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  const { endpoint, keys } = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api("/push/web", { endpoint, p256dh: keys.p256dh, auth: keys.auth });
}

// `open`: where a tapped notification takes the page. Returns the bar to show (null when none is due).
export function useWebNotifications(signedIn: boolean, open: (path: string) => void) {
  const [key, setKey] = useState<string>();
  const [ask, setAsk] = useState(false);

  useEffect(() => {
    if (!signedIn || !supported()) return;
    let off = false;
    void api<{ key: string | null }>("/push/web/key")
      .then(async ({ key }) => {
        if (off || !key) return;
        setKey(key);
        if (Notification.permission === "granted") await subscribe(key); // keeps this sign-in's link to the browser current
        else if (Notification.permission === "default" && !remembered()) setAsk(true);
      })
      .catch(() => {});
    const onMessage = (e: MessageEvent) => typeof e.data?.open === "string" && open(e.data.open);
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      off = true;
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [signedIn, open]);

  const answer = async (yes: boolean) => {
    setAsk(false);
    try {
      localStorage.setItem(ASKED, "1");
    } catch {}
    if (yes && key && (await Notification.requestPermission()) === "granted") await subscribe(key).catch(() => {});
  };
  return ask ? (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-3 border-b bg-muted px-4 py-1.5 text-sm">
      Want a notification when Emplio has something for you while you&apos;re away?
      <Button size="sm" onClick={() => void answer(true)}>
        Turn on
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void answer(false)}>
        Not now
      </Button>
    </div>
  ) : null;
}

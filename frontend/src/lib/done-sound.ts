"use client";

import { useEffect, useRef } from "react";

// A short chime when a chat's reply or a job finishes while Emplio isn't in front of the person (a background tab, or
// another window has focus). Web only: the Mac and phone apps' own notifications make their sound. On unless turned
// off in Settings, kept per device.
const KEY = "emplio-done-sound";

export function doneSoundOn() {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setDoneSoundOn(on: boolean) {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {}
}

// The ids that were running in `before` and aren't in `after`, though still listed (a deleted chat didn't finish).
export function finished(before: Set<string>, after: { id: string; running: boolean }[]) {
  return after.filter((x) => before.has(x.id) && !x.running).map((x) => x.id);
}

let last = 0;
// public/sounds/done.mp3: "New Notification 010" by Universfield, from Pixabay (free to use, no credit needed)
export function chime() {
  const now = Date.now();
  if (now - last < 2000) return; // a chat and its job ending together: one chime
  last = now;
  void new Audio("/sounds/done.mp3").play().catch(() => {});
}

const webOnly = () =>
  !document.documentElement.hasAttribute("data-desktop") && !(window as { Capacitor?: unknown }).Capacitor;
// the same test the server is told for its notifications (useLiveEvents)
const away = () => !(document.visibilityState === "visible" && document.hasFocus());

// Chimes when something in `items` stops running while the person is away.
export function useDoneSound(items: { id: string; running: boolean }[] | undefined) {
  const running = useRef(new Set<string>());
  useEffect(() => {
    if (!items) return;
    if (finished(running.current, items).length && away() && webOnly() && doneSoundOn()) chime();
    running.current = new Set(items.filter((x) => x.running).map((x) => x.id));
  }, [items]);
}

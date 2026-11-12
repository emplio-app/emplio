# Notifications

One server function, `pushTo` (`backend/src/push.ts`), decides where an event goes. Every trigger calls it; clients only show.

## Triggers (same as the iPhone push before)

1. A chat reply finished while nobody was watching that chat (`chat.ts`; not for automations, jobs, Telegram, or a stopped reply).
2. Anything posted from background work: check-ins, task results, reminders (`channels/index.ts` `post`).
3. An approval ("Needs your OK: ...") for a job (`channels/index.ts` `askOnPhone`).

## Routing

- Desktop app connected: the server sends `notify` over the device link; the app shows a native notification (also from the menu bar). It skips it when that chat is open in the focused window. If the app can't show it (old version, no notifications), the browser is tried instead.
- Otherwise: web push to the person's browsers (service worker `frontend/public/sw.js`; also skips when that chat is focused).
- iPhone: always, as before (another device).
- The same event to the same person within 10 seconds goes out once.

## Setup

Make a VAPID key pair once and put it in the server environment:

```bash
bun backend/scripts/vapid-keys.ts
```

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com   # optional
```

Without the keys the browser bar never shows. Chrome needs https (or localhost). The desktop app needs nothing: macOS asks the first time it shows one.

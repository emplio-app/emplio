// Shows Emplio's notifications in the browser while no tab is open (the server sends them: backend/src/push.ts).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let note;
  try {
    note = event.data.json();
  } catch {
    return;
  }
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // they're looking at that chat right now: nothing to add
      if (tabs.some((t) => t.focused && new URL(t.url).pathname === note.path)) return;
      await self.registration.showNotification(note.title || "Emplio", { body: note.body, icon: "/icons/icon-192.png", tag: note.path, data: { path: note.path } });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.path || "/";
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const tab = tabs.find((t) => new URL(t.url).origin === self.location.origin);
      if (!tab) return void (await self.clients.openWindow(path));
      await tab.focus();
      tab.postMessage({ open: path });
    })(),
  );
});

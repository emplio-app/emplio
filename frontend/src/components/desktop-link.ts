import { useEffect } from "react";
import { API_URL, api } from "@/lib/api";

// What the Emplio desktop app (desktop/ in this repo) lets the page ask of it.
type Desktop = {
  info(): Promise<{ installId: string; name: string; platform: string; state: string; userId: string | null } | null>;
  connect(options: { apiUrl: string; token: string; userId: string }): Promise<boolean>;
  onState(listener: (state: string) => void): () => void;
  onOpen?(listener: (path: string) => void): () => void;
};

// In the desktop app, once signed in: get this computer added to the person's account and hand the app the key it
// connects with, so Emplio can use the computer while it is awake. The app keeps the key, so this runs again only when
// it has none (first time, or the computer was removed) or a different person signed in. Nothing shows.
export function useDesktopLink(userId: string | undefined, open: (path: string) => void) {
  useEffect(() => {
    const desktop = (window as { emplioDesktop?: Desktop }).emplioDesktop;
    if (!userId || !desktop) return;
    let busy = false;
    const pair = async () => {
      if (busy) return;
      busy = true;
      try {
        const info = await desktop.info();
        if (!info || !(info.state === "needs-pairing" || (info.userId !== userId && info.state !== "off"))) return;
        const { token } = await api<{ id: string; token: string }>("/devices", { installId: info.installId, name: info.name, platform: info.platform });
        await desktop.connect({ apiUrl: API_URL, token, userId });
      } catch {
        // tried again next time the page opens
      } finally {
        busy = false;
      }
    };
    void pair();
    const offState = desktop.onState((state) => state === "needs-pairing" && void pair());
    // a tapped notification (desktop/src/main.js) asks for its chat
    const offOpen = desktop.onOpen?.(open);
    return () => (offState(), offOpen?.());
  }, [userId, open]);
}

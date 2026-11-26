import { type RefObject, useEffect } from "react";

// The phone app's page never pinch-zooms, as an app's own screens don't (mobile/ios/App/App/AppDelegate.swift
// ZoomPlugin). An open file zooms within its own frame instead (usePinchZoom), the bars around it staying put.
type Zoom = { set(o: { allowed: boolean }): Promise<void> };
export function useAppZoom() {
  useEffect(() => {
    const cap = (window as { Capacitor?: { Plugins?: { Zoom?: Zoom }; isPluginAvailable?(n: string): boolean } }).Capacitor;
    if (cap?.isPluginAvailable?.("Zoom")) void cap.Plugins?.Zoom?.set({ allowed: false }).catch(() => {});
  }, []);
}

// Two fingers on the frame scale what's in it (CSS zoom, so the frame's own scrolling pans it, with momentum),
// around the point between the fingers; 1x to 5x. For pictures and PDFs only: on a web page CSS zoom re-lays the
// page out (it reflowed like a narrower screen) rather than magnifying it.
export function usePinchZoom(frame: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, on = true) {
  useEffect(() => {
    const box = frame.current;
    const inner = content.current;
    if (!on || !box || !inner) return;
    let scale = 1;
    let start = 0;
    let from = 1;
    const apart = (t: TouchList) => Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY);
    // the second finger down: from here the two fingers are this frame's, not the web view's to scroll with (a
    // touchstart cancelled, so WebKit starts no gesture of its own; touch-action keeps it from zooming the page)
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      start = apart(e.touches);
      from = scale;
    };
    // WebKit's own pinch events: cancelled too, the scale is worked out from the touches above
    const gesture = (e: Event) => e.preventDefault();
    const move = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !start) return;
      e.preventDefault();
      const t = e.touches;
      const r = box.getBoundingClientRect();
      const mx = (t[0]!.clientX + t[1]!.clientX) / 2 - r.left;
      const my = (t[0]!.clientY + t[1]!.clientY) / 2 - r.top;
      const next = Math.min(5, Math.max(1, (from * apart(t)) / start));
      const k = next / scale;
      if (k === 1) return;
      const x = box.scrollLeft;
      const y = box.scrollTop;
      scale = next;
      inner.style.zoom = String(scale);
      // the point under the fingers stays under them
      box.scrollLeft = (x + mx) * k - mx;
      box.scrollTop = (y + my) * k - my;
    };
    const up = (e: TouchEvent) => {
      if (e.touches.length < 2) start = 0;
    };
    box.addEventListener("touchstart", down, { passive: false });
    box.addEventListener("gesturestart", gesture);
    box.addEventListener("gesturechange", gesture);
    box.addEventListener("touchmove", move, { passive: false });
    box.addEventListener("touchend", up);
    box.addEventListener("touchcancel", up);
    return () => {
      box.removeEventListener("touchstart", down);
      box.removeEventListener("gesturestart", gesture);
      box.removeEventListener("gesturechange", gesture);
      box.removeEventListener("touchmove", move);
      box.removeEventListener("touchend", up);
      box.removeEventListener("touchcancel", up);
      inner.style.zoom = "";
    };
  }, [frame, content, on]);
}


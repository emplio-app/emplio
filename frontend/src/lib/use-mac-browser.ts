"use client";

import { useEffect, useState } from "react";

// A Mac's browser (not an iPad asking for the desktop site, and not the Emplio app itself): the only visitors the Mac app is offered to.
// ponytail: false on the first render, so the server's page and the browser's agree.
export function useIsMacBrowser() {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    const inApp = !!(window as { emplioDesktop?: unknown }).emplioDesktop;
    setMac(!inApp && /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints < 2);
  }, []);
  return mac;
}

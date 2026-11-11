// A small tap from the phone at the moments that matter (sent, switched, approved, a sheet thrown shut), on the
// same frame as what caused it. The iPhone app's plugin when the build has it; Android browsers vibrate;
// everywhere else nothing happens.
type Plugin = {
  impact(o: { style: "LIGHT" | "MEDIUM" | "HEAVY" }): Promise<void>;
  notification(o: { type: "SUCCESS" | "WARNING" | "ERROR" }): Promise<void>;
};

export function haptic(kind: "tap" | "success" | "error" = "tap") {
  if (typeof window === "undefined") return;
  const plugin = (window as { Capacitor?: { Plugins?: { Haptics?: Plugin } } }).Capacitor?.Plugins?.Haptics;
  if (plugin) {
    const sent = kind === "tap" ? plugin.impact({ style: "LIGHT" }) : plugin.notification({ type: kind === "success" ? "SUCCESS" : "ERROR" });
    return void sent.catch(() => {});
  }
  navigator.vibrate?.(kind === "tap" ? 8 : kind === "success" ? [10, 40, 10] : [30, 40, 30]);
}

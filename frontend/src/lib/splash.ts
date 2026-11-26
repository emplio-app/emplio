// The phone app's opening screen stays up until the first screen has drawn (mobile/capacitor.config.js keeps it at
// most 3s), not a fixed moment that could leave a blank page showing. Nothing outside the app.
export function hideSplash() {
  type Splash = { hide(o?: { fadeOutDuration?: number }): Promise<void> };
  const splash = (window as { Capacitor?: { Plugins?: { SplashScreen?: Splash } } }).Capacitor?.Plugins?.SplashScreen;
  void splash?.hide({ fadeOutDuration: 250 }).catch(() => {});
}

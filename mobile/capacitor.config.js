// The app is the Emplio website in a native shell: changes to the site reach the app without a store update.
module.exports = {
  appId: "app.emplio",
  appName: "Emplio",
  webDir: "www",
  // opens on the app itself, not the marketing page (already signed in, /login goes straight to /home)
  server: { url: process.env.CAP_SERVER_URL || "https://emplio.app", appStartPath: "/login" },
  // how the site knows it is inside the app (iPhone and Android) (cloud/frontend/client.tsx hides buying)
  appendUserAgent: "EmplioApp",
  // scrollEnabled false: the page itself never scrolls (each screen scrolls inside), so iOS can't slide the whole app
  // up to a box being typed in and back down again (#34)
  // handleApplicationNotifications false: AppDelegate.swift takes notification events itself (replies from the lock
  // screen) and hands Capacitor the rest
  ios: { contentInset: "never", allowsLinkPreview: false, scrollEnabled: false, handleApplicationNotifications: false },
  plugins: {
    // iPhone: the app runs on under the keyboard and the page makes room the moment it starts to rise
    // ((app)/layout.tsx useFitToScreen). "native" shrank the app only once the keyboard was up plus 0.2s, with
    // black behind its rounded corners. Android: resizeOnFullScreen shrinks the app to the space above it.
    Keyboard: { resize: "none", resizeOnFullScreen: true },
    // hidden by the site once its first screen is drawn (frontend/src/lib/splash.ts); 3s at most, for a site without that
    SplashScreen: { launchAutoHide: true, launchShowDuration: 3000, backgroundColor: "#1a613f" },
  },
};

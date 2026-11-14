// The app is the Emplio website in a native shell: changes to the site reach the app without a store update.
module.exports = {
  appId: "app.emplio",
  appName: "Emplio",
  webDir: "www",
  // opens on the app itself, not the marketing page (already signed in, /login goes straight to /home)
  server: { url: process.env.CAP_SERVER_URL || "https://emplio.app", appStartPath: "/login" },
  // how the site knows it is inside the app (cloud/frontend/client.tsx hides buying)
  appendUserAgent: "EmplioApp",
  // scrollEnabled false: the page itself never scrolls (each screen scrolls inside), so iOS can't slide the whole app
  // up to a box being typed in and back down again (#34)
  // handleApplicationNotifications false: AppDelegate.swift takes notification events itself (replies from the lock
  // screen) and hands Capacitor the rest
  ios: { contentInset: "never", allowsLinkPreview: false, scrollEnabled: false, handleApplicationNotifications: false },
  plugins: {
    // the keyboard shrinks the app to the space above it, like a native app, instead of covering the page
    Keyboard: { resize: "native", resizeOnFullScreen: true },
    SplashScreen: { launchAutoHide: true, launchShowDuration: 800, backgroundColor: "#1a613f" },
  },
};

// The app is the Emplio website in a native shell: changes to the site reach the app without a store update.
module.exports = {
  appId: "app.emplio",
  appName: "Emplio",
  webDir: "www",
  // opens on the app itself, not the marketing page (already signed in, /login goes straight to /home)
  server: { url: process.env.CAP_SERVER_URL || "https://emplio.app", appStartPath: "/login" },
  // how the site knows it is inside the app (cloud/frontend/client.tsx hides buying)
  appendUserAgent: "EmplioApp",
  ios: { contentInset: "never", allowsLinkPreview: false },
  plugins: { SplashScreen: { launchAutoHide: true, launchShowDuration: 800, backgroundColor: "#1a613f" } },
};

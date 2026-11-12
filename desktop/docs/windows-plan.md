# Emplio for Windows: plan

Not started. This is what we want, in the order we'd build it.

## What the Windows app is

The same app as on the Mac: Emplio's website in a window, plus the person's own computer working for Emplio while it is
awake. Same promise: Emplio can use their sign-ins and their own internet connection, and what it can touch is fenced.

## Phase 1: the browser (small, ships first)

Commands keep running in the cloud computer (the server already does that for any computer that can't run them). The Windows app is the
window and the agent's browser.

- **Say what this computer can do.** The device's info carries `commands: false` on Windows; the server (`devices.ts`,
  `sandbox.ts`) then uses the device only for the browser and keeps commands in the cloud computer. Today it assumes a device can do both.
- **Embedded browser pane** (`pane.js`, `cdp-filter.js`, `pane-ui.*`): Electron code, should run as is. To check on Windows: the
  `WebContentsView` drawn over the page, the DevTools port on loopback, `Target.createTarget` done by the app, page width fixed
  at 1280 (zoom to fit), watch-only shield until Take control.
- **Backup Chrome for sign-ins** (`chrome.js`): `fetchChrome` must download the Windows build of Chrome for Testing
  (`win64`, zip, not tar), `findChrome` must look in `%ProgramFiles%`, `%LocalAppData%` (Chrome, Edge), and the process kill on stop
  must work (Windows has no `SIGTERM` for children; use `taskkill /T`).
- **Paths** (`paths.js`, `box.js` `ensure`): the business folder is `%USERPROFILE%\Emplio\<business>`; nothing in the browser path
  may assume `/` separators or `/tmp` (downloads go to `<work>\tmp\downloads`).
- **Window**: `titleBarStyle: "hidden"` with `titleBarOverlay` (already set, height 56) draws the minimise / maximise / close
  buttons on the right of the page's top row. The page already makes that row draggable; it needs right padding of about
  140px on Windows so the page's own buttons (Live browser) don't sit under them.
- **Tray**: Windows has no menu-bar title; use the tray icon and a tooltip instead of `tray.setTitle`.
- **Start with Windows** and **keep running when the window is closed** (the app hides its window on close; on Windows that
  means living in the tray). Add `app.setLoginItemSettings`.
- **Packaging**: `@electron/packager` for `win32`/`x64` (and `arm64`), icon `build/icon.ico` (make from the same logo with
  `make-assets.py`), installer with Squirrel/NSIS (`electron-builder` or `electron-winstaller`), updater later.
- **Signing**: an Authenticode certificate (EV avoids the SmartScreen warning). Without it, Windows warns "unknown publisher".

Done when: a Windows PC signs in, a chat's browser opens inside the app, a Google sign-in works through "Sign in with Chrome",
and the sign-ins are saved and come back, same as on the Mac.

## Phase 2: commands on the person's own computer

Emplio's commands are Linux shell scripts (`sandbox.ts` writes bash; the `emplio` tool is a bash function). On the Mac they run
in `/bin/bash` fenced by `sandbox-exec`. Windows needs both a Linux shell and its own fence.

- **Recommended: a dedicated WSL2 distro.** The app installs and owns a small distro ("Emplio"), mounts only
  `C:\Users\<you>\Emplio` into it and nothing else (no `/mnt/c`), and runs commands there. Behaviour matches the cloud computer, and the fence is
  the distro's own file system. Costs: WSL and virtualisation must be on (usually admin once, then a restart), the first start
  downloads a root file system.
- Not Git Bash: it isn't Linux (`setsid`, paths, tools differ) and has no fence.
- Anyone who doesn't set up WSL stays on Phase 1 (commands in the cloud computer).
- Work: a `box-wsl.js` next to `box.js` (same interface: `ensure`, `run`, `read`, `remove`, `cancel`, `stopAll`), the distro
  bootstrap, a path mapper between `C:\...` and `/work`, and the `commands` flag turning `true` once the distro is ready.

## Phase 3: parity and polish

- Auto-update, crash reports, the `Emplio` folder in Explorer's sidebar.
- Windows specifics for the browser: file dialogs, notifications, protocol handler (`emplio://`).
- Security review of the fence (WSL distro mounts, what the page can ask of the app).

## Open questions

- Which Windows versions: 10 (22H2) and 11 only? WSL2 needs 10 2004+.
- A code-signing certificate: who buys it, and which store (EV needs a hardware token or a cloud signing service).
- Do we ship arm64 Windows (Snapdragon laptops) from the start or later?

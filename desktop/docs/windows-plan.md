# Emplio for Windows

Built (not yet tried on a real PC). The same app as on the Mac: Emplio's website in a window, plus the person's own
computer working for Emplio while it is awake, so the work runs there instead of on a paid cloud computer.

## How commands run

- **Native, in Git Bash.** Emplio's commands are bash, so the app fetches Git for Windows' portable copy once
  (`tools.js`, into `%USERPROFILE%\Emplio\.tools`, checked against its SHA-256) and runs each command in its bash. The agent
  is told it's on Windows in the note on each message (`sandbox.ts` `computerNote`): Unix tools and git work, and so do
  Windows programs (`powershell -c`, `cmd //c`, any .exe).
- **Python for kept scripts.** Every script Emplio keeps (skills, tools) is Python, so it runs on the Mac, Windows and the
  cloud alike. The app fetches its own Python (python-build-standalone) on Windows and the Mac.
- **Paths.** The business folder is `%USERPROFILE%\Emplio\<business>`; `/work` in commands becomes its Git Bash form
  (`/c/Users/...`), and every form a program prints (`/c/...`, `C:\...`, `C:/...`) goes back as `/work` (`box.js` `back`).

## The fence (`fence-win.js`)

Commands run at Low integrity, the way Chrome fences its tabs. No admin rights needed.

- The bash program is labelled Low, so it and everything it starts run at Low.
- Each business folder is labelled Low: the only place a command may write (its TEMP is inside it).
- The person's keys (`.ssh`, `.aws`, ...), browser data, personal folders (Desktop, Documents, Downloads, ...) and the
  app's own data are labelled Medium with No-Read-Up: a Low command can't read them. Labelled once; what's added later inherits it.
- Before the PC takes any work, a test command checks from inside the fence that it runs at Low, can write its own
  folder, can't write outside it and can't read the app's data. Until it passes the app tells the server
  `win32-getting-ready`, and commands stay on the cloud computer (tried again every 10 minutes).

## Still to do

- Try it on a real Windows 10 and 11 PC: the fence test, a chat's commands, the browser pane, Chrome sign-in.
  Unknown until then: whether Git Bash's runtime is happy at Low integrity (the fence test says so if it isn't).
- `fetchChrome` for Windows (Chrome for Testing `win64`); Chrome or Edge already installed is used today.
- Packaging: `npm run win` makes a zip of the app. An icon (`build/icon.ico`, needs `rcedit`, so Windows or wine), an
  installer, auto-update and an Authenticode certificate (without it Windows warns "unknown publisher") come next.
- The Downloads page (emplio-cloud) shows Windows as "On its way" until it's tried.

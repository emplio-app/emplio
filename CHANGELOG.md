# Changelog

The newest version is at the top, and its heading is where Emplio's version number lives. "What's new" is shown to people in the app, so keep it in everyday words. See [CONTRIBUTING.md](CONTRIBUTING.md#releasing-a-new-version).

## 1.2.15 (2026-11-13)

### What's new

- Sign in with Google now works on emplio.app.

### For developers

- Google sign-in's callback falls back to `WEBHOOK_URL` when `PUBLIC_API_URL` isn't set, as live has only that; it was sending Google back to `localhost`.

## 1.2.14 (2026-11-13)

### What's new

- A new chat now offers real jobs to start with, like checking competitors' websites, drafting replies to enquiries, or a price list made from your website. Tap one and Emplio starts. ![](frontend/public/whats-new/1.2.14-jobs.webp)
- Before you connect Google Calendar, Docs, Sheets, Meet or Analytics, Emplio shows what it will do and how your data is used. Your Google data is never used to train AI, and disconnecting also removes Emplio's access in your Google account. ![](frontend/public/whats-new/1.2.14-google.webp)
- Emplio now only uses AI services that don't keep or learn from your data.
- Google Calendar asks for less: Emplio can see your calendars and manage events, but can't create, delete or share whole calendars.
- Ask Emplio to change a setting or rename your business in the chat. It always asks for your OK first.
- Settings has new Business and You tabs for your business name and your own name, email, phone and Telegram.
- Sign in with Google, and new businesses get a free trial to try Emplio with.

### For developers

- First-run flow (#85, cloud #14): free trial lot per person (ref = sha256 of the normalised email), Haiku lock while on it, console kill switch and `FREE_TRIALS_PER_DAY` cap; welcome dialog, job cards, Telegram offer after the second message; plans dialog in the app.
- Google sign-in at `/auth/google` (needs `GOOGLE_SIGN_IN=1` plus keys); `safeNext` keeps sign-in redirects on this app's own pages.
- `emplio settings` (list, `set <setting> <value>`, `set name`, `set my-name`): every change waits for an Allow card with no "Always allow"; API keys refused.
- Google verification: Calendar scopes are `calendar.events` + `calendar.readonly`, admin actions (`acl_*`, `calendars_*`, calendar list writes) dropped; `GET /connect/:app` shows a disclosure page for Google apps until `agreed=1`; disconnect revokes the token at Google (`oauth.revoke`); every OpenRouter call sends `provider.data_collection: "deny"`. Privacy policy has a "Google user data" section (`/privacy#google`).

## 1.2.13 (2026-11-13)

### What's new

- Emplio now has a Mac app. It gives Emplio a browser of its own on your Mac, runs its work right on your computer for faster replies, and keeps going from the menu bar after you close the window. Get it from the Downloads page on emplio.app. ![](frontend/public/whats-new/1.2.13-mac-app.webp)
- Get a notification the moment work is done or Emplio needs your OK, on your Mac or in Chrome, even when Emplio isn't open. Turn it on when Emplio asks. ![](frontend/public/whats-new/1.2.13-notifications.webp)
- The browser you watch on the web now looks the same as on the Mac: tabs, an address bar, and the full height of the page.

### For developers

- Desktop app (`desktop/`, Electron): the agent's browser is an embedded Chromium pane reached over the device link, with Chrome for Testing as a backup, sign-in save and restore, commands run on the Mac when it is online, an offline page, and a menu-bar background mode with a hidden host window (#86).
- Web Live view (`backend/src/browser-host.ts`) draws tabs and an address bar and fits the page to the panel height over CDP (#86).
- Mac app and Chrome notifications: `web_push_devices` table, `backend/src/webpush.ts`, a service worker, and `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in the server settings; `backend/scripts/vapid-keys.ts` makes a pair (#86).
- `/download/mac` passes the Mac app through from storage so the browser stays on the site; the `/downloads` pages and the storage route live in the cloud folder (#86).

## 1.2.12 (2026-11-12)

### What's new

- Emplio now runs a team: it hands each piece of work to the right agent, checks what comes back, and stays free to talk with you while they work. Ask for more and the same agent carries on. ![](frontend/public/whats-new/1.2.12-team.webp)
- Watch your agents work: each agent's browser shows beside the main chat, a tab each. ![](frontend/public/whats-new/1.2.12-browsers.webp)
- Above the message box, a short list shows which agents are still working or have a question, however far up you asked. Tap one to open it.
- When work finishes, the line in the chat says which agent finished what.

### For developers

- Manager mode (#74): Emplio's main chat plans, hands off, checks and relays; agents do the work. `emplio hand <agent>` carries on that agent's latest job in the chat, `--new` starts a fresh one (refused while it's working or asking). No top-level `myself`; Emplio's own chats can't use the browser; soft command reminders only. Emplio does work itself only when the chat, its notes and its jobs' reports cover it in two commands or fewer, and writes final collated reports itself as one markdown file.
- `[SILENT]` replies (after sending work back, answering a job, or while a related job is still running) mark nothing unread and send no push.
- `GET /conversations/:id/working` lists a chat's top-level jobs that are working or asking (`WorkingJob`), with `browser` when its live view is up; it feeds the strip and the browser panel's tabs. A finished job that carries on takes the new brief's first line as its name and chat title.
- New evals: `evals/manager` (32 single decisions) and `evals/workday` (whole conversations on a fake computer); `bun evals/workday/report.ts old.jsonl new.jsonl` compares runs. Right call 72% → 94–98%; workday steps right 71% → 93%.

## 1.2.11 (2026-11-12)

### What's new

- When Emplio asks for your OK, the card names the action in plain words, like "Create a pull request".
- The Reply button on text you select stays with it while you scroll, and slides over when you select more or something else.

### For developers

- Own-provider actions get a `title` from their name (`actionTitle`, shared); cards saved with the code name show it too (#82).
- Quote button follows the selection on scroll (page-wide captured listener, once a frame), hides only while it's out of the chat's view, and fades in place so the next selection glides; no glide while scrolling (#83).

## 1.2.10 (2026-11-12)

### What's new

- After an update, a short card shows what's new, with a picture for each change. Swipe or tap Next to go through it, or Skip to close it. ![](frontend/public/whats-new/1.2.10-just-updated.webp)

### For developers

- A "What's new" line can end with a picture or GIF, `![](frontend/public/whats-new/x.gif)`. `GET /changelog` now returns `changes` as `{ text, image? }`, and each device shows one slide per new pictured line after an update. GitHub release notes link pictures to the raw file.

## 1.2.9 (2026-11-12)

### What's new

- The card where Emplio asks for your OK is shorter: it never covers more than half the screen, the short details come first, and long text like an email shows a few lines with "Show all".
- The card's edges and shadow no longer look cut off in light mode.

### For developers

- Approval card: short fields first, long values (over 4 lines or 240 characters) clamp to 4 lines with Show all / Show less, also in the answered card; holder capped at `min(28rem, 50dvh)` and no longer scrolls, so it doesn't clip the card's ring and shadow (#79).

## 1.2.8 (2026-11-12)

### What's new

- When Emplio asks for your OK on something long, like an email or a pull request, the Allow and Deny buttons now always stay on screen. The details scroll above them.
- In spreadsheets, double-click the edge of a column heading to make the column fit its longest text, like in Excel.

### For developers

- Waiting approval card: header and buttons don't shrink, the fields scroll between them; the per-field height cap is dropped there so there's one scroll area (#75).
- Sheet viewer: double-clicking a column's resize handle fits it to its longest shown value, capped at 1000px; rows keep double-click to reset (#77).

## 1.2.7 (2026-11-12)

### What's new

- Long work no longer stops halfway and says it's done. When a helper runs out of steps it keeps going on its own, for up to 2 hours, and if it still can't finish it says so plainly.
- Helpers working through big documents save what they find as they go, so nothing has to be read twice, and they build the file you asked for step by step.

### For developers

- Jobs carry on in a fresh run after the step limit until `JOB_MINUTES` (now 120) is up; a run cut off by the step limit or by time reports "not finished" with status `failed`, not `done`. Default `maxSteps` 60 → 100. A timed-out run (`aborted`) no longer counts as completed. Job rules: extract big documents into a small file once and build the result as you go (#72).

## 1.2.6 (2026-11-11)

### What's new

- Buying a plan after the free period now starts the month's usage at 0%. Any free usage you had left is kept as extra usage.

### For developers

- Emplio Cloud billing: a first plan payment moves leftover founding, pass or free credit into extra usage, so it no longer counts in the month's percentage; a cloud migration fixes businesses already on a plan.

## 1.2.5 (2026-11-11)

### What's new

- When a new version is ready, the button now says "Update".
- The install guide shows how to check the install script before running it.

### For developers

- New-version bar button reads "Update" instead of "Refresh"; it still reloads the page (#69).
- README: the install checksum check is a visible section with a direct link to `install.sh.sha256` (#68).

## 1.2.4 (2026-11-11)

### What's new

- Emplio works better on a phone. Nothing hides under the clock or the home bar any more, the file viewer and live browser have a Back button, sheets don't throw the keyboard over themselves, and the menu now opens from a button at the top left of every page.
- Download and Export to Excel now work in the iPhone app: they open the share sheet, so you can Save to Files, AirDrop or Mail.
- Closing the keyboard no longer jumps the chat to the end.
- The iPhone app now shows your usage.
- DeepSeek models can be picked in Settings.
- Before installing a skill from the store, Emplio can read it first and install only one that fits.

### For developers

- Phone layout: one `--safe-top`/`--safe-bottom` pair for safe areas, top-left menu button (`SidebarTrigger`) on phones, bottom bar down to four tabs, sheet and dialog fixes; downloads in the app go through `saveFile` and the share sheet; chat keeps its distance from the end across resizes (#61).
- DeepSeek added to `MODEL_PROVIDERS` (#54).
- `emplio skills show <owner/repo/skill>`: read a store skill without installing it (#55).

## 1.2.3 (2026-11-11)

### What's new

- Searching your chats now shows chats whose name matches first, so typing "posthog" finds the chat called "Install PostHog MCP" at the top.
- New apps Emplio can work in: Google Business Profile (your listing on Google, with reviews first: read them, see the average, reply), Google Search Console, Google Analytics and Bing Webmaster Tools.
- Swipe can now start automations: a new invoice, a payment, an overdue invoice, low stock and more.

### For developers

- `/search` lists title matches first, then message matches from other chats; `emplio history search` is unchanged (#59).
- Google Business Profile as an own integration, 98 actions and 5 polled triggers; needs Google's Business Profile API access approved before it works (#58).
- Google Search Console (13 actions, 8 triggers) and Google Analytics 4 (190 actions, 9 triggers) on the shared Google sign-in (#60).
- Bing Webmaster Tools, all 62 methods as actions plus 4 polled triggers, connected with a pasted API key (#62).
- Swipe triggers: 7 from Swipe's webhook (set up with `get_webhook_setup`) and 8 polled (#57).

## 1.2.2 (2026-11-11)

### What's new

- Emplio can now upload files on sites that hide the spot to drop a file, like a Reddit community icon or a YouTube profile picture. It clicks the site's Upload button and hands over the file.

### For developers

- `emplio browser upload` takes a file box or the button that opens one; for a button it clicks it with the page set to give any file box it opens the files. The agent's browser guide now lists the command (#63).

## 1.2.1 (2026-11-11)

### What's new

- The card under a reply now only shows when one tap can answer it, and waits until Emplio's agents have finished. No more buttons like "Send the repo" that can't actually answer.
- Emplio is better at saving a skill when it learns how to do something, and suggests making an agent when the same kind of work keeps coming back.
- When Emplio closes its browser, it really closes, so a phone-size page it set up for a test doesn't stick around.

### For developers

- The next-step card writer moved to `backend/src/next-step.ts`; evals live in `backend/evals/` (run with `bun run eval evals`, results to Braintrust) with a repo skill on adding one. New dev dependencies: `braintrust`, `@braintrust/bt` (#23).
- `emplio browser close` stops the chat's browser after the command, saving sign-ins first (#50).
- Docs: Google Search Console ownership tag (#45).

## 1.2.0 (2026-11-11)

### What's new

- On phones, Emplio feels more like a phone's own app: sheets follow your finger and close with a quick flick, the bottom bar is frosted glass with your lists scrolling under it, and buttons give a little when pressed.
- If your phone is set to reduce motion, things now fade instead of sliding or zooming everywhere in the app.
- "Allow" requests now wait just above the chat box, so they stay in view however much is written after them. Once answered, each shows in one line whether it was allowed and how it went.
- Emplio no longer asks you to tap Allow after you already have.
- The next-step card no longer makes the chat jump, and editing a tapped answer shows just your answer.
- On phones, the buttons under a sent message no longer sit on top of the reply.
- When Emplio reports a problem, the step it took now shows in its list of actions.
- Emplio can test a website at phone size: its browser keeps the page size it was asked for.

### For developers

- Approvals have their own `approvals` table and `GET /conversations/:id/approvals`; cards are no longer part of a command's result, so the model never reads them. Cards left waiting by a restart are closed at the next start (#41).
- `emplio browser set viewport` is replayed before each later browser command for that chat's browser, and a hosted browser that won't change size is restarted at the asked size; `emplio browser viewport W H` is a short form (#44, #47).
- A browser being stopped is no longer picked up again (#42).
- `emplio report` shows in a reply's actions (#39).
- The phone app adds `@capacitor/haptics`; taps need the next iPhone build (#46).
- `/site/...` hands over to Emplio Cloud's pages, not found without the cloud folder (#43). Commits made as "Emplio" are exempt from the CLA check (#31).
- Database migration: `approvals`.

## 1.1.0 (2026-11-09)

### What's new

- After a reply, a small card sums up where things stand and asks what to do next. Tap an answer, or press Cmd+Enter (Ctrl+Enter on Windows) for the first one. Close it if you don't need it.
- Stripe, Asana, ClickUp, Airtable, HubSpot and Calendly now connect with a key you paste in.
- Emplio's browser costs less to run: it starts on a regular connection and moves to a local one only when a site needs it.

### For developers

- The next-step card replaces the greyed-out message guess: `GET` and `DELETE /conversations/:id/next-step` replace `GET /conversations/:id/suggestion`.
- Eight apps moved off Composio, with a shared webhook route and OAuth refresh tokens. Notion and Todoist stay on Composio on Emplio Cloud for now (#16).
- Sign-in integrations for Slack, Zoom, Google Calendar, Docs, Sheets, Meet and Zoho. Set `KEEP_ON_COMPOSIO` to keep an app on Composio, and `OWN_APP_TESTERS` to try ours on chosen workspaces (#19).
- Browsers start with no proxy and switch when a site blocks them or needs a sign-in; `emplio browser local` asks for it directly (#17).
- iPhone notifications go straight through Apple, off unless `APNS_KEY_ID`, `APNS_TEAM_ID` and `APNS_KEY` are set (#20).
- Database migrations: connection refresh tokens, paid sites, and push devices.

## 1.0.0 (2026-11-09)

### What's new

- See what's changed any time, from What's new in your account menu.
- Emplio tells you when a new version is ready, and one tap brings your screen up to date.
- Replies are shorter: a line or two, unless you ask for more.

### For developers

- `CHANGELOG.md` is the one place versions live. `GET /health` reports the running version and `GET /changelog` the "What's new" lines.
- The app compares the version it first saw with the server's on reconnect, on focus and every 5 minutes, and offers a reload when they differ.
- Each new version on `main` publishes a GitHub release and version-tagged Docker images.
- Tightened the default reply length in the system prompt (#2).

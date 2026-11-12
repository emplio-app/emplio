# Changelog

The newest version is at the top, and its heading is where Emplio's version number lives. "What's new" is shown to people in the app, so keep it in everyday words. See [CONTRIBUTING.md](CONTRIBUTING.md#releasing-a-new-version).

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

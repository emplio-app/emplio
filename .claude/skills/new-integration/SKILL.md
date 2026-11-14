---
name: new-integration
description: Build a complete Emplio integration of our own from just an app's name - every action its API has, every trigger it can send, sign-in with a key, OAuth or both, its logo, catalog entry, tests and coverage notes. Use when asked to add, build or connect an app or connector ("add Linear", "build a Notion integration", "/new-integration Stripe"), to move an app off Composio, or to bring an existing own app up to full coverage.
---

# New integration

Input: an app's name. Output: one PR where that app connects, can do everything its API allows, and can start
automations from everything it can report.

**Coverage is the job.** Six actions and one trigger is a broken integration, because Emplio will tell people it can't
do the other forty things. Every operation becomes an action and every event becomes a trigger, unless `COVERAGE.md`
says why not. "Not needed yet" is not a reason.

The worked example to copy is `backend/src/integrations/own/github/` with `polls/github.ts` and
`backend/scripts/openapi/github.ts`. It has every part this skill asks for.

## Decide without asking

Emplio's users are business owners and this code is ours, so settle these from the research: which sign-in methods to
build (all the app offers), names, category, descriptions, which triggers are webhooks and which are polled.

Stop and ask only for:
- Anything that must happen in the user's own account: registering an OAuth app, a paid plan, a partner application.
- A test login for a live check. Never ask for it in chat (see Secrets).
- Commit, PR and going live.

Say what you're building in a sentence or two before you start.

## 1. Research

Run these together. Write the findings straight into the plan, not into prose.

**Is it already here?** `grep -n '"<app>"' backend/src/integrations/catalog.ts`. If it's `composio(...)`, this is a
migration: read step 7.

**The API's own list of operations.** In order of preference:
1. An official OpenAPI spec. Try `/openapi.json`, `/openapi.yaml`, `/swagger.json` on the API and docs hosts, then the
   company's GitHub organisation (`<org>/openapi`, `<org>/rest-api-description`, `<org>/api-spec`).
2. A Postman collection or the SDK's source, which lists every endpoint.
3. The docs, page by page. Use Context7 first, and `curl | grep` the raw page when a site renders with JavaScript.

Three failed searches means the search is failing, not that the list doesn't exist.

**The benchmark.** `https://docs.composio.dev/toolkits/<slug>` lists Composio's tools and triggers for that app. We must
match or beat it. `n8n` (a local clone is often in `~/dev/tools/n8n/n8n/packages/nodes-base/nodes/`) shows the app's
quirks: `GenericFunctions.ts` for pagination and odd errors, `*Trigger.node.ts` for how webhooks are registered.

**Write down before any code:**

| Question | Why |
| --- | --- |
| Key, OAuth, or both? Where does a key come from? | Sign-in |
| OAuth: scopes and separator, do tokens expire, is there a refresh token, can expiry be turned off? | Step 3 |
| Base URL, per-tenant host, auth header | `Api` in `own/openapi.ts` |
| Pagination, rate limits, errors that come back as 200 | `failed`, `deadToken`, test cases |
| Webhooks: events, how to register them by API, signature scheme, delivery id, per account or per resource? | Step 4 |
| Events with no webhook but a list to compare | `polls/<app>.ts` |
| Calls that hand back a secret, and POSTs that only read | `secrets`, `reads` |

## 2. Actions

**With a spec:** write `backend/scripts/openapi/<app>.ts` and generate.

```bash
cd backend && bun scripts/openapi-actions.ts <app>
```

- `name`: if Composio has this app, name actions the way it does (`get_a_tree`), so skills and automations keep working.
- `skip`: only operations a connected person's login can't call, or ones the provider marks deprecated. Each with a reason.
- `reads`: POSTs that only look things up. Then they run without asking.
- `secrets`: GETs that return a secret. Then they ask first.
- Read what the generator printed as skipped. "Body type not supported" is a gap to fill by hand.

**Without a spec:** write them in `own/<app>/`, split by resource, with the same standard: a zod `input` whose every field
has a `.describe()` written for someone who has never read the app's docs, and `readOnly: true` only on what truly
changes nothing. `own/plivo` and `own/livekit` list their calls by hand and still run through `own/openapi.ts`.

**Then on top, where it helps:** hand-written actions for what the raw API makes awkward, like a file download returned
as an `AppFile`. Add convenience on top of full coverage, never instead of it.

## 3. Sign-in

In `own/<app>/index.ts`, export an `OwnApp`:

- `app`, `name`, `logo: "/logos/<app>.svg"`.
- `keyField`: label, placeholder, and `help` saying exactly where to get the key and which permissions to tick.
- `check(key)`: one cheap call. Throw `AppsError` if it fails. Return the account's name to label the connection.

**If the app offers OAuth,** add `oauth: { ready, authorizeUrl, exchange }`, reading `<APP>_CLIENT_ID` and
`<APP>_CLIENT_SECRET`, with `ready()` false when they're missing. Then key and sign-in both appear in the Connect dialog.
Scopes: everything the actions need. Make the app's consent screen always show, so a link someone was sent can't finish
by itself (GitHub: `prompt=select_account`).

- Tokens: `exchange` keeps one string and nothing refreshes it. Turn expiry off when the app allows that (GitHub's
  "Expire user access tokens"). If tokens must expire, add refresh as part of this job, with a test. Don't ship a login
  that dies in an hour.
- OAuth only, no keys: `keyField` is required today. Make it optional through `OwnApp`, `getApp` and `connect()`.
- Document both variables in `.env.example` and `docs/self-host/configuration.mdx`.

**Registering the OAuth app** is part of building the integration. Do it in the user's real Chrome (Claude in Chrome),
signed in as them, not the built-in browser, in a new tab. Close the tab when finished.

1. Open the app's developer settings and create an OAuth app. If it needs a paid plan, a partner application or a
   company review, stop and tell the user what it asks for.
2. Fill it in:

   | Field | Value |
   | --- | --- |
   | Name | `Emplio` |
   | Homepage | `https://emplio.app` |
   | Descriptions | Every short and long one the app has, even if optional: what Emplio does in that app, in plain words. People read these on the consent screen and app page |
   | Callback / redirect URL | `https://api.emplio.app/oauth/<app>/callback`, exactly |
   | Scopes, if set here | The same list as `authorizeUrl` |
   | Expiring tokens | Off, if the app allows it |
   | Wildcard redirects, device flow | Off |

3. **Upload the logo.** Use `frontend/public/icons/icon-512.png`, the square Emplio mark. Find the page's file input and
   use `file_upload` on it. Clicking the upload button opens a file picker the tools can't reach. Finish any crop step,
   press save, then reload the page and look at the logo to confirm it stuck. People see this on the consent screen,
   so it isn't optional.
4. Register it and read the **client ID**, which is public. Zoom in or read it from the page, since `l`, `I`, `0` and
   `O` look alike in a screenshot.
5. **Stop at the client secret.** Never click generate. Keep the tab open and tell the user to generate it, then give
   them the command under Secrets, filled in, to run themselves.
6. Check it arrived by name and length. The server reads it when it starts, so restart the API if the code is already
   live. Until then, the Connect dialog just offers the key alone.

Before calling OAuth done, check what the app demands before strangers can sign in: Google and Microsoft review
sensitive scopes, Slack and others have a "public distribution" switch, and some keep new apps in a test mode that only
listed users can pass. Turn on what's a switch. Tell the user about anything that takes a review.

A self-hosted server needs its own OAuth app, because the callback is built from that server's public address. Keep the
callback's shape in the self-host docs, and never commit our client ID.

## 4. Triggers

Every event, under Composio's name when it has one, so existing automation files keep working. Check with `coverage.ts`.

**Webhook when the app has one**, in `own/<app>/triggers.ts`, wired through `push` on the `OwnApp`:
- `start(key, connection, event, config)` registers it and returns the id events arrive under: `<app>:<connection>[:...]`.
- One webhook per connection (and per resource, where the app's webhooks are per resource). Find ours by URL first, add
  the event to it, and only then create one.
- `stop(key, id)` removes it when the last automation goes. Leave it out only if the app can't delete a webhook.
- Secret: an HMAC of `ENCRYPTION_KEY` and the connection id. Worked out, never stored.
- Route in `automations.ts`, next to Razorpay's and GitHub's: check the signature over the raw body with a timing-safe
  compare, skip delivery ids already in `seen`, answer at once, handle the event in the background.
- `config` on each trigger: what it needs, plus filters the server applies (branch, one issue, a folder). A filter here
  costs nothing. A condition in the prompt wakes the AI every time.
- Strip the payload of link clutter (`eventData`). Events are cut at 20,000 characters.
- If a run could cause the same event again (replying to a comment), say so in the trigger's description.

**Polled for the rest**, in `polls/<app>.ts`, added to `APPS` in `polls/index.ts`: `poll()` returns current items, each
with an id that never changes. For "changed" rather than "new", put the change into the id (`<id>:<updated_at>`).

Also register app-wide webhooks in the app's dashboard if that's the only way it offers them, and say so to the user.

## 5. Logo and listing

- `frontend/public/logos/<app>.svg`, from the company's press kit or `https://cdn.simpleicons.org/<slug>` (with brand
  colour). It sits on a white tile, so a white logo is invisible. Open the file and look at it.
- Add to `APPS` in `own/index.ts`.
- Add to `catalog.ts` with `own("<app>", "<Name>", "<category>", "<what it does>")`. One plain line a business owner
  understands: what they can get done, not the API's nouns.

If the app hosts code, one line in `HOSTS` in `git-proxy.ts` plus its login gives `git` on Emplio's computer too.

## 6. Check it

```bash
cd backend && bunx tsc --noEmit
bun test src/integrations/own/<app>/
bun ../.claude/skills/new-integration/coverage.ts <app> [composio-slug]
```

**Coverage:** triggers must show 0 unmatched. Go through every unmatched action: a renamed one, or a convenience
something else covers, is fine. A real capability gap gets built, or gets a reason in `COVERAGE.md`. GraphQL-only features
often show up here.

**Tests** in `own/<app>/<app>.test.ts`, with `fetch` faked: key accepted and refused; OAuth round trip and a forged state;
reads run unasked and writes ask; a file comes back as a file; webhook registered, extended and removed; each event
starts only the right triggers; filters; a bad signature gets 401 through the real route.

Noise on our SSD: `._*.test.ts` files report errors, and tests that need Postgres fail without a local database. Compare
against the same run without your changes. A `mock.module` lasts for the whole test run, so spread the real module into it.

**Live**, once it's deployed, on the real site in the user's Chrome. Use a throwaway resource you create for the test
(a private repository, a test board), never the user's real data, and a new chat:

1. Before connecting, ask Emplio for something that needs the app. The Connect card should appear by itself.
2. Open the card. Both "Sign in with <App>" and the key box should show, with the logo.
3. Click sign in. It opens a separate window the tools can't see, and the permission is the user's to grant, so ask them
   to approve it there. Then confirm the card turned to Connected with the right account name.
4. Run one read and one write with that sign-in. A write should show its Allow card. Allow once, never "Always allow".
5. Trigger: have Emplio save an automation with a filter-free prompt ("tell me the title"), then cause a real event.
   Confirm the app's delivery log shows 200, the message arrives in the main chat, and the run is in the history.
6. Remove the automation and confirm the webhook is gone from the app.
7. Clean up. Ask before permanently deleting the throwaway resource.

Say plainly in the final message what was not tried live.

**`COVERAGE.md`** next to the code: the source and date, what was left out and why, sign-in methods, adjustments by hand,
triggers, and actions by group with `*` on those that ask first. `own/exa/COVERAGE.md` is the format.

## 7. Moving an app off Composio

Change `composio(...)` to `own(...)` in `catalog.ts`. Connections made through Composio then show as expired and must be
reconnected (`moved()` in `integrations/index.ts`). Tell the user who's affected before it goes live, and keep action and
trigger names the same so saved automations carry over once reconnected.

## Secrets

- Never type, read, screenshot or print a client secret, token or key. Not in chat, not in a page you're looking at.
- The user generates the secret and adds it to the server from their own terminal, with a hidden prompt:

```bash
read -rs "S?<App> client secret: "; printf '\n<APP>_CLIENT_ID=<id>\n<APP>_CLIENT_SECRET=%s\n' "$S" | ssh <server> 'cat >> <backend>/.env'; unset S
```

- Check it arrived by name and length only: `awk -F= '/^<APP>_CLIENT_/{print $1, length($2)}' .env`.

## Finishing

- Work on a branch. Commit and push only when asked, with no AI attribution anywhere.
- PR, the user merges, then production, and ask before it goes live.
- Words people see say "Emplio", in plain business language. UI uses shadcn components only.
- Close by telling the user what's left for them: the OAuth secret, and anything not tested live.

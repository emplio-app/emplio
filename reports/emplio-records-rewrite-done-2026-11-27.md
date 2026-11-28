# Records rewrite: done (27 Nov 2026)

The founder-persona review **approved** the change after two rounds. Nothing is committed yet.

## What changed

The database now holds clients, contacts, projects, services, stages, client details and team titles. Notes files hold only words.

- **Same rules for the app and Emplio.** Both go through one set of server functions.
- **History.** Every change is recorded with who made it and whether it was the app or Emplio. A contact's change shows on every client it belongs to. A moved project shows on both the old and the new client.
- **Conflicts.** A change made after someone else's is refused, and the message names who changed it.
- **Archive and restore.** Delete-for-good is owner-only and refused while anything links to the record.
- **Role checks.** Only owners and admins can change money, stage, handlers, archive or lead.
- **Duplicate check.** The app says "did you mean X?" and offers Open or Add anyway.
- **Currency.** The business's currency is set in Settings → Business or with `emplio settings set currency GBP`. Amounts already saved keep the currency they were written in.
- **Deleting a business works.** Links are checked at commit. `src/records.test.ts` guards this.

App pages:
- **Clients:** tabs for Active, Prospects, Past, All and Archived, plus a Stages and details editor.
- **Client page:** typed details, a Contacts card (adding an existing person links them), a Projects card (adding one starts its service's process), and a History card that shows from → to.
- **Projects, Contacts and Services:** lists, add forms, an Archived toggle, and one side panel that edits any of them in place.
- **Other pages:** Team shows job titles and what each person handles or leads. Tasks have a project picker. Today lists projects due within a week. Memory links open the record.

Checked:
- Backend and frontend typecheck clean.
- Self-checks pass.
- Records tests pass 2/2.
- The wider backend run passed 85/86. The one failure is a Gitea 401 in a hand-off test, which is test-environment sign-in, not this code.
- Tried in the browser against the local copy.

## Rollout (in this order, one window)

1. Rehearse on a copy of production. Run `bun scripts/files-to-records.ts` as a dry run, then `--apply`, then `--reconcile`. Every business must come out clean.
2. Deploy the code, run migration A, and run `files-to-records --apply` back to back. Between the migration and the apply, client lists are empty.
3. Run `--reconcile` on production.
4. Only after every business reconciles clean, run migration B (drops the old `client` text columns).
5. New version gets a changelog entry first, as usual.

## Follow-ups (agreed, not done)

- **Merge duplicates.** Add `emplio clients merge a b`, the same for contacts, and an app button. It moves tasks, runs, projects and history.
- **Hide fees from staff.** Fold this into the per-client visibility work.
- **Background agent permissions.** It writes to records with member-level rights instead of the owner's.
- **New businesses default to INR.** Guess the currency from the owner's region at sign-up.
- **Reordering.** Drag to reorder stages and details.
- **Live refresh.** Records changed by Emplio refresh in the app when the window regains focus, not instantly.

# Contributing

Thanks for helping make Emplio better. Bug reports, ideas and pull requests are all welcome.

## Before your first pull request

You'll be asked to sign our [contributor agreement](CLA.md) on your first pull request. A bot comments with the one line to reply. It takes a minute and you only do it once. You keep the copyright in your work.

For anything bigger than a small fix, open an issue first so we can agree on the approach before you spend time on it.

Please report security problems privately, as [SECURITY.md](SECURITY.md) explains, not in a public issue.

## Running it from source

You need [Bun](https://bun.sh) 1.3 and [Docker](https://docs.docker.com/get-docker/). To run your changes, build everything in Docker:

```bash
git clone https://github.com/emplio-app/emplio && cd emplio
bun install
./setup.sh --build
```

Before you push, check that the types still line up:

```bash
bun run typecheck
```

The tests need PostgreSQL and Gitea running. [.github/workflows/ci.yml](.github/workflows/ci.yml) shows exactly how CI sets them up, and it runs on every pull request, so you can also leave the tests to it.

## The `cloud` folder

`cloud/` is where Emplio Cloud, our hosted service, keeps its own parts: billing, our website and the paid providers it runs on. It isn't part of this repo, so your clone doesn't have it, and the app runs fine without it.

Everything works without it. The app uses the open parts instead: a Docker computer, Chromium, files on disk and a SQLite file per business. The places where the cloud plugs in are `backend/src/cloud.ts` on the server and `frontend/src/no-cloud/` on the website. You don't need to change those for most work.

## Pull requests

- Keep each one to a single change, with a short description of what it does and why.
- Add or update a test when you change behaviour.
- Match the style of the code around you.

## Releasing a new version

Add a section at the top of `CHANGELOG.md`, in the same pull request as the change or on its own:

```md
## 1.1.0 (2026-11-20)

### What's new

- Written for the people using Emplio, in everyday words.

### For developers

- The technical detail. This part only appears on GitHub.
```

A "What's new" line can end with a picture or GIF of the change, kept in `frontend/public/whats-new/`:

```md
- Approval cards keep their buttons on screen. ![](frontend/public/whats-new/1.3.0-approval.gif)
```

After an update, everyone gets a short card with one slide for each new line that has a picture, newest first, 10 at most. Lines without one only appear under What's new in the account menu, and an update with no pictures shows no card.

That heading is the only place the version number lives. Once it's merged, CI publishes the GitHub release and version-tagged images, and once it's running, open screens offer a refresh. CI fails if the format is wrong.

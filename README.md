<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.png">
    <img src="docs/images/logo-light.png" alt="Emplio" height="64">
  </picture>
</p>

<h3 align="center">The open-source, self-learning AI employee.</h3>

<p align="center">
  Emplio works alongside your team with its own computer and browser.<br>
  Tell it once, or show it once, and it remembers how your business does things.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="https://docs.emplio.app">Docs</a> ·
  <a href="#the-vision">Vision</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="#how-it-learns">How it learns</a> ·
  <a href="#is-this-just-another-one-of-those-agents">Another agent?</a> ·
  <a href="https://emplio.app">Emplio Cloud</a> ·
  <a href="https://discord.gg/vjAr5ARex">Discord</a> ·
  <a href="LICENSE">AGPL-3.0</a>
</p>

https://github.com/user-attachments/assets/fa225020-2aa2-4892-8895-dcc1fe1760b1

<p align="center">
  <img src="docs/images/demo.gif" alt="Emplio answering wholesale enquiries, making a quote, and learning a new credit rule">
</p>

> [!NOTE]
> **We've used Emplio every day at Kulp Labs, our software agency, since May 2026. Opening it up to everyone is new.** It has worked really well for us, but your business will use it in ways ours hasn't, so you may run into rough edges. If something breaks, please [open an issue](https://github.com/emplio-app/emplio/issues). We'd love to hear what you think on [Discord](https://discord.gg/vjAr5ARex).

## The vision

Most AI agents are built for one person. Emplio is built for the whole company.

Every business, from a freelancer to an enterprise, should have an employee who knows the whole company: what it sells, who does what, and where it's trying to go. Emplio works alongside every person on the team, takes the repetitive work off everyone's plate so people can spend their time on growth, and keeps pushing the business toward its goals around the clock. It gets better every day, and everything it learns belongs to the business.

## What it does

Emplio is one colleague your whole team can talk to, on the web or on Telegram. Ask it for something the way you'd ask a person, and it does the work, not just the writing.

- **Has its own computer and browser.** It runs commands, opens websites, fills in forms and makes real files: quotes, invoices, spreadsheets, decks.
- **Works in your apps.** Gmail, Calendar, Drive, Sheets, Zoho Books and more, plus any MCP server you add.
- **Keeps your records.** A built-in database for leads, orders and stock that it reads and updates as it works.
- **Runs the to-do list.** Give tasks to Emplio or to people. It does its own, chases everyone else's and tells you what needs you.
- **Works without being asked.** A morning brief, scheduled jobs, and long work handed off to its own agents in the background.
- **Fits a real team.** Owners, admins and staff, who reports to whom, and restricted files staff can't see. Each person gets their own computer and browser, kept apart from everyone else's.

<p align="center">
  <img src="docs/images/work-dark.png" alt="The Work page: tasks for Emplio and for people, with what's waiting and what's done">
</p>

## How it works

<p align="center">
  <img src="docs/images/how-it-works-dark.png" alt="Your team talks to Emplio on the web, Telegram or by voice; Emplio works on its own computer, its own browser and your apps, and keeps memory, records and the work list, learning as it goes">
</p>

## How it learns

Emplio gets better at your business the longer it works there.

- **Tell it once.** "Give new cafés 30 days' credit" becomes a rule in company memory, and it applies it from then on.
- **Show it once.** Record yourself doing something in the browser and Emplio turns it into a skill it can repeat.
- **It hires its own help.** When a kind of work keeps coming back, Emplio sets up an agent for it, like an Invoice Chaser, and each agent keeps lessons from its past jobs.
- **You can read all of it.** Memory is plain notes, kept in git with full history. Change anything, any time.

<table>
  <tr>
    <td width="50%">
      <img src="docs/images/memory-dark.png" alt="Company memory: the notes Emplio keeps about how the business works">
    </td>
    <td width="50%">
      <img src="docs/images/team-dark.png" alt="The team: people with their roles, and the agents Emplio set up">
    </td>
  </tr>
  <tr>
    <td align="center"><b>Memory</b>: plain notes, kept in git</td>
    <td align="center"><b>Team</b>: your people and Emplio's agents</td>
  </tr>
</table>

## Is this just another one of those agents?

Fair question. Lots of agents have their own computer and run all day now. The difference is who they work for. Most work for one person. Emplio works for the company.

- **It works toward your goals.** Tell it where the business is headed. It keeps that in mind on every job, looks for work that moves the goals forward on its own, and keeps a running note of progress.
- **One memory for the whole team.** Teach it something once and it applies for everyone, not just the person who taught it.
- **It sees across the company.** It spots promises nobody turned into a task and chases what's running late.
- **The right access for each person.** Owners, admins and staff see different things, and everyone gets their own private computer and browser.
- **Real records.** Customers, orders and stock live in a proper database, not buried in chat history.
- **You own it.** It's open source, runs on your server or ours, works with any model, and its memory is plain notes you can read and edit.

Other agents make a great assistant for you. Emplio is staff for your company.

## Install

Run this on your computer or your server:

```bash
curl -fsSL https://emplio.app/install.sh | bash
```

It asks for an [OpenRouter](https://openrouter.ai/keys) key for the AI models, your email, and your web address if you have one, then gives you a link that signs you in as the owner.

- **On a computer:** leave the web address empty. Emplio opens at http://localhost:3000.
- **On a server:** point your web address at the server and open ports 80 and 443 first. HTTPS is set up for you.

You need [Docker](https://docs.docker.com/get-docker/). On a Linux server the installer can add it for you. On a Mac or Windows, install Docker Desktop first. Plan for at least 4 GB of memory, and 2 GB more for each person working at the same time.

Run the same command again to update. Your settings and data stay.

The full guide, from setup to every setting, is at [docs.emplio.app](https://docs.emplio.app).

<details>
<summary><b>Check the script before running it</b></summary>

`emplio.app/install.sh` sends you to [install.sh](install.sh) in this repo. To read it first and make sure what you downloaded is exactly that file:

```bash
curl -fsSLo install.sh https://emplio.app/install.sh
curl -fsSL https://raw.githubusercontent.com/emplio-app/emplio/main/install.sh.sha256 | shasum -a 256 -c
bash install.sh
```

The second line prints `install.sh: OK` when the file matches. If it doesn't, don't run it, and please [tell us](https://github.com/emplio-app/emplio/issues).

</details>

<details>
<summary><b>Adding your team</b></summary>

Add people from the Team page. With no email service set up, their sign-in codes are written to the log:

```bash
cd ~/emplio && docker compose logs app | grep "sign-in code"
```

Add `RESEND_API_KEY` to `~/emplio/.env` and run `docker compose up -d` so people get their codes by email.

</details>

<details>
<summary><b>Optional features</b></summary>

Web search, app connections, voice notes, Telegram and email each turn on when you add their key to `.env` and run `docker compose up -d`. See `.env.example`. Apps like Razorpay and Vercel only need a key pasted into the Integrations page.

</details>

<details>
<summary><b>Backups</b></summary>

Back up the Docker volumes `postgres-data`, `gitea-data` and `app-data`, and keep your `.env`. Without `ENCRYPTION_KEY`, saved passwords can't be read.

</details>

<details>
<summary><b>Build it yourself</b></summary>

To run your own changes instead of the ready-made version:

```bash
git clone https://github.com/emplio-app/emplio && cd emplio && ./setup.sh --build
```

</details>

## Self-hosted or Emplio Cloud

| | Self-hosted | [Emplio Cloud](https://emplio.app) |
|---|---|---|
| Cost | Free, plus your own AI and other provider bills | Paid plans |
| Computer | A container on your machine | Managed for you |
| Browser | Plain Chromium; some sites will block it | Managed, with protection against blocking |
| Links to apps the agent starts | Not available yet | Yes |
| Keys and setup | Yours | Done for you |

## Security

Emplio runs commands and opens websites for you, so treat it like a member of staff with a computer.

- Each person's computer and browsers run in their own containers and network.
- Only the small `runner` service controls Docker, and only for Emplio's own two images. Don't give that access to anything else.
- Never put this on the internet without HTTPS.

## Where your data goes

Emplio does its thinking with an AI model through [OpenRouter](https://openrouter.ai), so the model company you choose sees what it works on:

- what people send it in chat, files included
- the company notes it opens for a job (staff never get the restricted ones)
- what its commands print, the text of pages it reads, and what it pulls from connected apps
- new messages in a quiet chat, which a smaller model reads so the background agent knows what's going on

The model never gets:

- saved passwords and keys, or the keys and sign-ins for connected apps. They're stored encrypted on your server, and the server uses them itself, so the model only knows their names and sees the results. Once a password is typed into a website, though, the agent could read it back from that browser.
- browser cookies, your database or your encryption key

Other services only get data if you add their key: Exa (web searches), Composio (app connections), Sarvam (voice notes), Resend (sign-in emails) and Telegram (messages sent there).

You pick the model in Settings. To stop model companies keeping what they're sent, turn on zero data retention in your [OpenRouter privacy settings](https://openrouter.ai/settings/privacy).

OpenRouter is the only option today. We're working on more providers, and on running local models so nothing has to leave your server.

## Community

Questions, ideas, or want to show what Emplio does for your business? Join us on [Discord](https://discord.gg/vjAr5ARex).

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). First-time contributors sign a short [contributor agreement](CLA.md) on their first pull request.

## License

The code is under the [GNU Affero General Public License v3.0](LICENSE). If you run a changed version as a service, you must offer your users its source code.

"Emplio" and its logo are trademarks and aren't covered by that license. If you offer your own changed or hosted version, give it another name.

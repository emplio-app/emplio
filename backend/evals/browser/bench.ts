// Browser benchmark: an agent job's own instructions (chat.ts, sandbox.ts, jobs.ts), the real `emplio` command and
// agent-browser, a real Chrome on this machine, and a made-up shop admin (site.ts). It counts what each task cost
// and checks what the site says happened. Two versions of the code side by side: point BENCH_SRC at the other
// one's backend/ (a worktree with node_modules linked in).
//
//   bun evals/browser/bench.ts out.jsonl [tasks...]            this code
//   BENCH_SRC=/path/to/other/backend bun evals/browser/bench.ts base.jsonl
//   bun evals/browser/bench.ts --report base.jsonl out.jsonl   side by side
//
// BENCH_TRIALS (3), BENCH_MODEL (the agents' model), BENCH_PARALLEL (3). Needs Google Chrome and OPENROUTER_API_KEY.
// Runs on bash, not code mode: the browser commands, the wrapper and the instructions are the same either way.
// ponytail: macOS Chrome path and agent-browser's darwin build; add Linux paths if this runs in CI
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { MODEL_SETS } from "@emplio/shared";
import { generateText, stepCountIs, tool } from "ai";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import type { z } from "zod";
import { fresh, serve, type State } from "./site";

process.env.CODE_MODE = "0";
const SRC = resolve(process.env.BENCH_SRC ?? join(import.meta.dir, "../.."), "src");
const MODEL = process.env.BENCH_MODEL ?? MODEL_SETS.save.jobModel;
const TRIALS = Number(process.env.BENCH_TRIALS ?? 3);
const PARALLEL = Number(process.env.BENCH_PARALLEL ?? 3);
const CHROME = process.env.BENCH_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// BENCH_MODE=vision: the page by sight only, as computer-use harnesses do it: every browser command answers with a
// screenshot, clicks are x y, no page text (snapshot, find, read, calls/send refused).
const VISION = process.env.BENCH_MODE === "vision";
// BENCH_MODE=hybrid: every command is there, but the guide says sight first; screenshots come after commands that change the page
const HYBRID = process.env.BENCH_MODE === "hybrid";
// BENCH_SHOT_SCALE=0.6: screenshots shrunk before the model sees them (tokens go by pixels, not file size); its x y are scaled back
const SCALE = Number(process.env.BENCH_SHOT_SCALE ?? 1);
const HYBRID_GUIDE = `[Browser. Work by sight first: every command that changes the page answers with a screenshot of it (x y in its pixels).
emplio browser open <url>
emplio browser click <x> <y>
emplio browser keyboard type "text"   # into whatever has focus: click the box first
emplio browser press Enter            # also Tab, Escape, Backspace
emplio browser scroll down 600        # or up
Chain several with && when you already know the next spots.
A dropdown: its list doesn't show in screenshots. Click it, press Escape, then press the option's first letter, again until the screenshot shows it.
Text tools, only when sight isn't enough (many rows or numbers to read, a long page, something off screen): emplio browser read (the page's text), snapshot -i | grep -i <word> (refs like @e3 for click/fill), find text "Save" click. The site's own requests: emplio browser calls, send. Check the screenshot before saying it's done.]`;
const VISION_GUIDE = `[Browser, by sight. Every emplio browser command answers with a screenshot of the page after it (x y in its pixels). Page text isn't available: work from the screenshot.
emplio browser open <url>
emplio browser click <x> <y>
emplio browser keyboard type "text"   # into whatever has focus: click the box first
emplio browser press Enter            # also Tab, ArrowDown, Control+a, Backspace
emplio browser scroll down 600        # or up
One command per call, or several chained with && when you already know the next spots (the screenshot shows the page after the last).
A dropdown: its list doesn't show in screenshots. Click it, press Escape, then press the option's first letter (press d), again until the screenshot shows it. Check the screenshot before saying it's done.]`;
const AB_VERSION = "v0.41.2";
const ROOT = join(tmpdir(), "emplio-browser-bench");

const SIGN_IN = "sign in with meera@kaveri.example / linen-2026";
type Task = { id: string; ask: (url: string) => string; check: (s: State, said: string) => boolean };
const patelSum = fresh().orders.filter((o) => o.customer.startsWith("Patel")).reduce((n, o) => n + o.total, 0);
export const TASKS: Task[] = [
  {
    id: "status",
    ask: (u) => `Our shop admin is at ${u} (${SIGN_IN}). Set order #1047 to Shipped and add the internal note "Sent via BlueDart".`,
    check: (s) => { const o = s.orders.find((x) => x.id === 1047)!; return o.status === "Shipped" && /BlueDart/.test(o.note) && s.orders.filter((x) => x.note).length === 1; },
  },
  {
    id: "refund",
    ask: (u) => `Our shop admin is at ${u} (${SIGN_IN}). Refund order #1012.`,
    check: (s) => s.orders.filter((x) => x.refunded).map((x) => x.id).join() === "1012",
  },
  {
    id: "settings-star",
    ask: (u) => `Our shop admin is at ${u} (${SIGN_IN}). Turn off the weekly digest email in the notification settings, and star order #1033.`,
    check: (s) => !s.digest && !s.sms && s.orders.filter((x) => x.starred).map((x) => x.id).join() === "1033",
  },
  {
    id: "read-patel",
    ask: (u) => `Our shop admin is at ${u} (${SIGN_IN}). What's the total of all orders from customers named Patel, across every page? Just the sum in rupees.`,
    check: (_s, said) => said.replace(/[,\s]/g, "").includes(String(patelSum)),
  },
  {
    id: "bulk",
    ask: (u) => `Our shop admin is at ${u} (${SIGN_IN}). Mark orders #1003, #1008, #1015, #1022, #1031, #1040, #1049 and #1057 as Delivered.`,
    check: (s) => {
      const want = new Set([1003, 1008, 1015, 1022, 1031, 1040, 1049, 1057]);
      const before = fresh().orders;
      return s.orders.every((o, i) => (want.has(o.id) ? o.status === "Delivered" : o.status === before[i]!.status));
    },
  },
  {
    id: "page-three",
    ask: (u) => `Our shop admin is at ${u} (${SIGN_IN}). Go through the orders list page by page (don't search) and tell me who placed order #1058 and its status.`,
    check: (s, said) => { const o = s.orders.find((x) => x.id === 1058)!; return said.includes(o.customer.split(" ")[0]!) && said.includes(o.status); },
  },
];

// BENCH_SET=real: public sites, read-mostly, answers checked against the live pages (fetched once at start)
const REAL = process.env.BENCH_SET === "real";
const REAL_SITES = /localhost|127\.0\.0\.1|toscrape|saucedemo|herokuapp|wikipedia|github/;
async function realTasks(): Promise<Task[]> {
  const travel = await (await fetch("http://books.toscrape.com/catalogue/category/books/travel_2/index.html")).text();
  const cheapest = Math.min(...[...travel.matchAll(/price_color">£([\d.]+)/g)].map((m) => Number(m[1]))).toFixed(2);
  const t = await (await fetch("https://the-internet.herokuapp.com/tables")).text();
  const rows = [...t.slice(t.indexOf('id="table1"'), t.indexOf('id="table2"')).matchAll(/<tr>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td>[^<]*<\/td>\s*<td>\$([\d.]+)<\/td>/g)].map((m) => ({ last: m[1]!, first: m[2]!, due: Number(m[3]) }));
  const top = rows.sort((a, b) => b.due - a.due)[0]!;
  const rel = (await (await fetch("https://api.github.com/repos/vercel-labs/agent-browser/releases/latest")).json()) as { tag_name: string };
  console.log("truths:", { cheapest, top, latest: rel.tag_name });
  return [
    { id: "books", ask: () => "On https://books.toscrape.com, open the Travel category and tell me the price of the cheapest book there and its title.", check: (_s, said) => said.includes(cheapest) },
    { id: "sauce", ask: () => "Our demo shop is https://www.saucedemo.com (sign in as standard_user / secret_sauce). Add the two cheapest products to the cart, check out as Sam Lee, postcode 10001, finish the order, and tell me the item total shown before finishing and the message after.", check: (_s, said) => said.includes("17.98") && /thank you for your order/i.test(said) },
    { id: "table", ask: () => "On https://the-internet.herokuapp.com/tables, in the first table (Example 1), which person has the largest amount due? Full name and amount.", check: (_s, said) => said.includes(top.last) && said.includes(top.first) },
    { id: "wiki", ask: () => "Open the English Wikipedia article on K2 (the mountain) and tell me the date of its first ascent and who made it, from the infobox.", check: (_s, said) => /31 July 1954|July 31, 1954/.test(said) },
    { id: "github", ask: () => "Go to https://github.com/vercel-labs/agent-browser and find the latest release. Tell me its version number.", check: (_s, said) => said.includes(rel.tag_name.replace(/^v/, "")) },
  ];
}

type Row = { changed?: unknown; task: string; trial: number; ok: boolean; steps: number; commands: number; input: number; cached: number; output: number; cost: number; images: number; browserChars: number; ms: number; said: string; error?: string; log?: { command: string; chars: number }[] };

async function agentBrowser() {
  const home = join(ROOT, "home");
  const bin = join(home, ".local/bin/agent-browser");
  if (existsSync(bin)) return home;
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  mkdirSync(join(home, ".local/share/agent-browser"), { recursive: true });
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const get = Bun.spawnSync(["bash", "-c", `curl -fsSL https://github.com/vercel-labs/agent-browser/releases/download/${AB_VERSION}/agent-browser-darwin-${arch} -o "${bin}" && chmod +x "${bin}" && curl -fsSL https://codeload.github.com/vercel-labs/agent-browser/tar.gz/refs/tags/${AB_VERSION} | tar -xz -C "${home}/.local/share/agent-browser" --strip-components=2 '*/skill-data/*'`]);
  if (get.exitCode) throw new Error(`getting agent-browser failed: ${get.stderr}`);
  return home;
}

async function chrome(dir: string) {
  const port = 9400 + Math.floor(Math.random() * 500);
  const p = Bun.spawn([CHROME, "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--no-first-run", "--window-size=1280,800", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 40; i++) {
    if (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false)) return { p, url: `http://127.0.0.1:${port}` };
    await Bun.sleep(250);
  }
  p.kill();
  throw new Error("Chrome didn't start");
}

// loaded once: several runs importing at the same time hit a module still initialising
let mods: Promise<any[]> | undefined;
const load = () => (mods ??= (async () => [await import(join(SRC, "chat.ts")), await import(join(SRC, "sandbox.ts")), await import(join(SRC, "jobs.ts")), await import(join(SRC, "settings.ts"))])());

async function runOne(task: Task, trial: number, home: string): Promise<Row> {
  const [{ emplioPrompt, agentRules, BASH_DESCRIPTION, bashInput }, { sandboxPrompt, browserGuide, EZ }, { RULES }, { DEFAULTS }] = await load();
  const run = mkdtempSync(join(ROOT, `${task.id}-`));
  const work = join(run, "work");
  mkdirSync(join(work, "tmp"), { recursive: true });
  mkdirSync(join(run, "bin"));
  writeFileSync(join(run, "bin/emplio"), EZ, { mode: 0o755 });
  const state = { s: fresh() };
  const site = serve(state);
  const browser = await chrome(join(run, "chrome"));
  const key = crypto.randomUUID().slice(0, 8);
  // its own: runs side by side once picked up each other's browser. The path has to stay under 104 bytes.
  const sockets = mkdtempSync("/private/tmp/ab-");
  const env = { PATH: `${join(run, "bin")}:${process.env.PATH}`, HOME: home, AGENT_BROWSER_SOCKET_DIR: sockets, BROWSER_CDP_URL: browser.url, BROWSER_SESSION: `b${key}`, EZ_KEY: key, EMPLIO_WORK: work };
  const ctx = { workspaceName: "Kaveri Home Furnishings", userName: "Meera", role: "owner" as const };
  const session = { conversationId: crypto.randomUUID(), workspaceId: "w", workspaceName: ctx.workspaceName, user: { id: "u", name: "Meera", email: "meera@kaveri.example" }, role: "owner", attachments: [], settings: DEFAULTS, watched: false, channel: "web", task: true };
  let images = 0;
  let browserChars = 0;
  let commands = 0;
  let guided = false;
  const log: { command: string; chars: number }[] = [];
  // a refused command is logged too, and in vision mode brings the guide if no browser command has yet
  const refuse = (command: string, why: string) => {
    log.push({ command: `[refused] ${command.slice(0, 300)}`, chars: 0 });
    const guide = VISION && !guided ? `\n\n${VISION_GUIDE}` : "";
    guided ||= VISION;
    return { exitCode: 1, output: why + guide, viewed: [] as string[] };
  };
  // the app's own schema and description, loaded from whichever code is being measured
  const bash = tool({
    description: BASH_DESCRIPTION,
    inputSchema: bashInput as z.ZodType<{ command: string }>,
    execute: async ({ command }: { command: string }) => {
      commands++;
      // a real admin needs its scripts and sign-in: the site is reached through the browser only, in both modes
      if (/\b(curl|wget|python3?|node|bun|nc|http|emplio web)\b/.test(command.replace(/emplio browser [^&;|]*/g, "")) && new RegExp(`(https?://|www\\.)[^\\s"']*(${REAL_SITES.source})`).test(command.replace(/emplio browser [^&;|]*/g, "")))
        return refuse(command, "That site only opens in the browser: use emplio browser.");
      if ((VISION || HYBRID) && /emplio[ .]browser/.test(command)) {
        const no = VISION && /emplio browser (snapshot|find|read|get|eval|calls|send|run|screenshot|skill|help)\b/.exec(command);
        if (no) return refuse(command, `emplio browser ${no[1]}: not in this mode, work from the screenshot.`);
        command = command
          .replace(/emplio browser click (\d+) (\d+)/g, "emplio browser mouse move $1 $2 && emplio browser mouse down left && emplio browser mouse up left")
          .replace(/emplio browser mouse move (\d+) (\d+)/g, (_, x, y) => `emplio browser mouse move ${Math.round(x / SCALE)} ${Math.round(y / SCALE)}`);
      }
      // /work is the computer's folder, as a person's own computer maps it (python/py/emplio _local)
      const local = command.replace(/(?<![\w.~/-])\/work(?=$|[\s/"';:)|&<>,}\]])/gm, work);
      const p = Bun.spawn(["bash", "-c", local], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => p.kill(), 120_000);
      const [out, err, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      clearTimeout(timer);
      // the server's part: emplio view's images go to the model, other emplio requests aren't served here
      const viewed: string[] = [];
      let output = (out + err)
        .split("\n")
        .filter((l) => {
          const v = /^VIEW:[^\t]*\t(.+)$/.exec(l);
          if (v) viewed.push(v[1]!);
          return !v && !/^[A-Z]+:[^\t]*\t@\/tmp\/emplio-req/.test(l);
        })
        .join("\n")
        .replaceAll(work, "/work")
        .slice(0, 16_000);
      if ((VISION || HYBRID) && /emplio[ .]browser/.test(command)) {
        if (HYBRID) browserChars += output.length;
        if (VISION || /emplio browser (open|goto|navigate|click|mouse|press|keyboard|fill|type|select|check|uncheck|scroll|find|back|forward|reload)\b/.test(command)) {
          await Bun.sleep(400);
          const shot = join(work, "tmp", `shot-${commands}.png`);
          Bun.spawnSync(["bash", "-c", `emplio browser screenshot "${shot}"`], { cwd: work, env });
          if (existsSync(shot)) viewed.push(shot);
        }
        output = output.replace(/^✓ ?/gm, "").trim();
        if (!guided) output += `\n\n${VISION ? VISION_GUIDE : HYBRID_GUIDE}`;
        guided = true;
      }
      if (!VISION && !HYBRID && /emplio[ .]browser/.test(command)) {
        browserChars += output.length;
        if (!guided) output += `\n\n${browserGuide(session, true)}`; // as the first in a chat gets it (sandbox.ts firstInChat)
        guided = true;
      }
      log.push({ command: command.slice(0, 300), chars: output.length, out: output.slice(0, 700), shots: viewed.length } as any);
      return { exitCode, output: output.trim() || "(no output)", viewed };
    },
    toModelOutput: async ({ output }: { output: { exitCode: number; output: string; viewed: string[] } }) => {
      if (!output.viewed.length) return { type: "json", value: { exitCode: output.exitCode, output: output.output } };
      images += output.viewed.length;
      const files = await Promise.all(
        output.viewed.map(async (path) => {
          // as the app sends one (files.ts forModel): at most 1200 on its long side
          const img = sharp(readFileSync(path));
          const { width = 1280 } = await img.metadata();
          const data = await img.resize(SCALE < 1 ? { width: Math.round(width * SCALE) } : { width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).png().toBuffer();
          return { type: "file" as const, data: { type: "data" as const, data: new Uint8Array(data) }, mediaType: "image/png" };
        }),
      );
      return { type: "content", value: [{ type: "text", text: JSON.stringify({ exitCode: output.exitCode, output: output.output }) }, ...files] };
    },
  });
  const began = Date.now();
  try {
    const cache = { type: "ephemeral" as const };
    const { steps } = await generateText({
      model: createOpenRouter()(MODEL),
      providerOptions: { openrouter: { cacheControl: cache, reasoning: DEFAULTS.reasoning === "off" ? { enabled: false } : { effort: DEFAULTS.reasoning }, usage: { include: true } } },
      system: [
        {
          role: "system" as const,
          providerOptions: { openrouter: { cacheControl: cache } },
          content: emplioPrompt({
            rules: agentRules(ctx, undefined, true),
            computer: HYBRID ? sightFirst(sandboxPrompt(session, true)) : sandboxPrompt(session, true),
            team: ["- Meera <meera@kaveri.example>, owner"],
            connected: "(none)",
            business: "We sell curtains, cushions and bed linen from one shop in Pune and online.",
            userName: "Meera",
            personal: "Runs the shop. Prefers short answers.",
            skills: ["(none yet)"],
            agent: true,
          }),
        },
        { role: "system" as const, content: `This chat's id is ${session.conversationId.slice(0, 8)}.` },
        { role: "system" as const, content: RULES(1, session.conversationId) },
      ],
      messages: [{ role: "user", content: `[From Emplio] ${task.ask(`http://localhost:${site.port}`)}` }],
      tools: { bash },
      stopWhen: stepCountIs(60),
    });
    const said = steps.map((s) => s.text).filter(Boolean).at(-1) ?? "";
    const raw = (s: (typeof steps)[number]) => (s.usage.raw ?? {}) as { cost?: number };
    return {
      task: task.id,
      trial,
      ok: task.check(state.s, said),
      steps: steps.length,
      commands,
      input: steps.reduce((n, s) => n + (s.usage.inputTokens ?? 0), 0),
      cached: steps.reduce((n, s) => n + (s.usage.inputTokenDetails?.cacheReadTokens ?? 0), 0),
      output: steps.reduce((n, s) => n + (s.usage.outputTokens ?? 0), 0),
      cost: steps.reduce((n, s) => n + Number(raw(s).cost ?? 0), 0),
      images,
      browserChars,
      ms: Date.now() - began,
      said: said.slice(0, 400),
      log,
      changed: changes(state.s),
    };
  } catch (error) {
    return { task: task.id, trial, ok: false, steps: 0, commands, input: 0, cached: 0, output: 0, cost: 0, images, browserChars, ms: Date.now() - began, said: "", error: String(error).slice(0, 300) };
  } finally {
    browser.p.kill();
    site.stop(true);
    rmSync(run, { recursive: true, force: true });
    rmSync(sockets, { recursive: true, force: true });
  }
}

// hybrid: the system prompt teaches sight first too, not only the guide that comes with the first browser result
const sightFirst = (p: string) => {
  const out = p.replace(/`emplio browser open <url>`, `emplio browser snapshot -i` \(refs\), `emplio browser click @e3`\./, "`emplio browser open <url>`, then work by sight: each command that changes the page answers with a screenshot, so click by position (`emplio browser click <x> <y>`) and don't read the page as text unless the screenshot isn't enough.");
  if (out === p) throw new Error("sightFirst: browser line not found");
  return out;
};

// what the run changed on the site, to see why one failed
const changes = (s: State) => {
  const f = fresh();
  const orders = s.orders.filter((o, i) => JSON.stringify(o) !== JSON.stringify(f.orders[i])).map((o) => `${o.id}:${o.status}${o.note ? ` note=${o.note}` : ""}${o.starred ? " starred" : ""}${o.refunded ? " refunded" : ""}`);
  return { orders, digest: s.digest, sms: s.sms, saves: s.saves };
};

function report(files: string[]) {
  const all = files.map((f) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row));
  const tasks = [...new Set(all.flat().map((r) => r.task))];
  const avg = (rows: Row[], k: keyof Row) => rows.reduce((n, r) => n + Number(r[k]), 0) / Math.max(1, rows.length);
  const line = (name: string, rows: Row[]) =>
    `${name.padEnd(14)} ok ${rows.filter((r) => r.ok).length}/${rows.length}  steps ${avg(rows, "steps").toFixed(1).padStart(5)}  input ${Math.round(avg(rows, "input")).toString().padStart(7)}  cached ${Math.round(avg(rows, "cached")).toString().padStart(7)}  output ${Math.round(avg(rows, "output")).toString().padStart(5)}  cost $${avg(rows, "cost").toFixed(4)}  images ${avg(rows, "images").toFixed(1)}  page text ${Math.round(avg(rows, "browserChars"))}  ${Math.round(avg(rows, "ms") / 1000)}s`;
  for (const [i, rows] of all.entries()) {
    console.log(`\n== ${files[i]}`);
    for (const t of tasks) console.log(line(t, rows.filter((r) => r.task === t)));
    console.log(line("ALL", rows));
    for (const r of rows.filter((r) => !r.ok)) console.log(`   failed ${r.task}#${r.trial}: ${r.error ?? r.said.replace(/\s+/g, " ").slice(0, 160)}`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--report") report(args.slice(1));
  else {
    const [out, ...only] = args;
    if (!out) throw new Error("usage: bun evals/browser/bench.ts <out.jsonl> [task...] | --report a.jsonl b.jsonl");
    mkdirSync(ROOT, { recursive: true });
    const home = await agentBrowser();
    const jobs = (REAL ? await realTasks() : TASKS).filter((t) => !only.length || only.includes(t.id)).flatMap((t) => Array.from({ length: TRIALS }, (_, i) => [t, i + 1] as const));
    let next = 0;
    await Promise.all(
      Array.from({ length: PARALLEL }, async () => {
        while (next < jobs.length) {
          const [t, i] = jobs[next++]!;
          const row = await runOne(t, i, home);
          appendFileSync(out, `${JSON.stringify(row)}\n`);
          console.log(`${row.ok ? "ok  " : "FAIL"} ${t.id}#${i} steps ${row.steps} $${row.cost.toFixed(4)}${row.error ? ` ${row.error}` : ""}`);
        }
      }),
    );
    report([out]);
  }
}

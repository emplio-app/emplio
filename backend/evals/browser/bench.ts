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
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
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

type Row = { task: string; trial: number; ok: boolean; steps: number; commands: number; input: number; cached: number; output: number; cost: number; images: number; browserChars: number; ms: number; said: string; error?: string; log?: { command: string; chars: number }[] };

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

async function runOne(task: Task, trial: number, home: string): Promise<Row> {
  const { emplioPrompt, agentRules, BASH_DESCRIPTION, bashInput } = await import(join(SRC, "chat.ts"));
  const { sandboxPrompt, browserGuide, EZ } = await import(join(SRC, "sandbox.ts"));
  const { RULES } = await import(join(SRC, "jobs.ts"));
  const { DEFAULTS } = await import(join(SRC, "settings.ts"));
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
  // the app's own schema and description, loaded from whichever code is being measured
  const bash = tool({
    description: BASH_DESCRIPTION,
    inputSchema: bashInput as z.ZodType<{ command: string }>,
    execute: async ({ command }: { command: string }) => {
      commands++;
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
      if (/emplio[ .]browser/.test(command)) {
        browserChars += output.length;
        if (!guided) output += `\n\n${browserGuide(session, true)}`; // as the first in a chat gets it (sandbox.ts firstInChat)
        guided = true;
      }
      log.push({ command: command.slice(0, 300), chars: output.length });
      return { exitCode, output: output.trim() || "(no output)", viewed };
    },
    toModelOutput: async ({ output }: { output: { exitCode: number; output: string; viewed: string[] } }) => {
      if (!output.viewed.length) return { type: "json", value: { exitCode: output.exitCode, output: output.output } };
      images += output.viewed.length;
      const files = await Promise.all(
        output.viewed.map(async (path) => {
          // as the app sends one (files.ts forModel): at most 1568 on its long side
          const data = await sharp(readFileSync(path)).resize(1568, 1568, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
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
            computer: sandboxPrompt(session, true),
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
    const jobs = TASKS.filter((t) => !only.length || only.includes(t.id)).flatMap((t) => Array.from({ length: TRIALS }, (_, i) => [t, i + 1] as const));
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

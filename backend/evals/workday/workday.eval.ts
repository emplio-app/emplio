// Whole conversations (scenarios.ts) on a fake computer that keeps track of the jobs Emplio hands off: it starts,
// carries on and refuses them the way the server does (src/jobs.ts hand), lists them in the note on each message,
// and brings each scripted report back when its turn comes. Nothing runs. `bun run eval evals/workday` in backend.
import { MODEL_SETS } from "@emplio/shared";
import type { ModelMessage } from "ai";
import { Eval } from "braintrust";
import { appendFileSync } from "node:fs";
import type { Business } from "../emplio";
import type { Expect, Scenario } from "./scenarios";

// loaded when first needed, not at the top (see ../README.md), and once: runs side by side would race on the cycle
let loaded: Promise<[typeof import("../emplio"), typeof import("../../src/chat"), typeof import("../../src/jobs"), typeof import("../manager/cases")]> | undefined;
const app = () => (loaded ??= (async () => [await import("../emplio"), await import("../../src/chat"), await import("../../src/jobs"), await import("../manager/cases")] as const)() as never);

type Job = { id: string; agent: string | null; name: string; status: "working" | "done" | "asking"; brief: string };
type Route = { agent: string; job: string; cont: boolean; brief: string };
export type StepResult = { step: number; ok: boolean; why: string[]; routes: Route[]; byHand: number; browser: boolean; said: string; usage?: { input: number; output: number; cost: number } };
type Input = { scenario: Scenario; carriesOn: boolean };
type Output = { steps: StepResult[] };

const nameOf = (line: string) => ({ name: /^- (.+?) \(agents\//.exec(line)![1]!, slug: /\(agents\/([^,)]+)/.exec(line)![1]! });

async function run({ scenario, carriesOn }: Input): Promise<Output> {
  const [{ reply, pretend, person }, { longRunNote, notCounted, refusal, remindAt, skillNote }, { reportsNote }, { AGENTS }] = await app();
  const agents = AGENTS.map(nameOf);
  const jobs: Job[] = [];
  let routes: Route[] = [];
  let lastJob: Job | undefined;
  const line = (j: Job) => `- ${j.id} · ${j.agent ?? "myself"} · ${j.name} · ${j.status}${j.status === "working" ? "" : ", 12 Nov, 10:05 am"}`;
  const head = (j: Job) => `${j.id} "${j.name}"${j.agent ? ` (${j.agent})` : ""}`;
  const latestOf = (agent: string | null) => [...jobs].reverse().find((j) => j.agent === agent);
  const carry = (j: Job, brief: string): string => {
    routes.push({ agent: j.agent ?? "myself", job: j.id, cont: true, brief });
    lastJob = j;
    if (j.status === "working") return `sent to ${head(j)}: it reads it after the step it's on`;
    j.status = "working";
    return `${head(j)} is working on it`;
  };
  const start = (agent: string | null, brief: string): string => {
    const j: Job = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 8), agent, status: "working", brief, name: (brief.split("\n").find((l) => l.trim()) ?? "work").replace(/^[#*\s]+/, "").slice(0, 60) };
    jobs.push(j);
    routes.push({ agent: agent ?? "myself", job: j.id, cont: false, brief });
    lastJob = j;
    return `started ${j.id} "${j.name}"${agent ? ` with ${agent}` : ""}`;
  };
  // the server's hand-off, old (an agent's name starts a fresh job) or new (it carries on that agent's job)
  const hand = (command: string): string => {
    const m = /\bemplio hand\s+(?:"([^"]+)"|'([^']+)'|(\S+))([^\n]*)/.exec(command)!;
    const pick = (m[1] ?? m[2] ?? m[3])!.trim();
    const flags = m[4] ?? "";
    const brief = command.split("\n").slice(1).filter((l) => !/^\s*EOF\s*$/.test(l)).join("\n") || command;
    const thread = /^[0-9a-f]{4,}$/i.test(pick) ? jobs.find((j) => j.id.startsWith(pick.toLowerCase())) : undefined;
    if (thread) return carry(thread, brief);
    if (/^[0-9a-f]{6,}$/i.test(pick)) return `error: no job ${pick} here. Nothing was started.`;
    if (pick.toLowerCase() === "myself") return carriesOn ? "error: work goes to an agent, not to a copy of you. Nothing was started." : start(null, brief);
    let agent = agents.find((a) => a.name.toLowerCase() === pick.toLowerCase() || a.slug === pick.toLowerCase());
    if (!agent) {
      if (!/--description\b/.test(flags)) return `error: there's no agent "${pick}". Nothing was started. If none fits, run it again with --description "<the kind of work it does>".`;
      agent = { name: pick, slug: pick.toLowerCase().replace(/\W+/g, "-") };
      agents.push(agent);
    }
    const current = latestOf(agent.name);
    if (carriesOn && current && !/--new\b/.test(flags)) return carry(current, brief);
    if (carriesOn && current && current.status !== "done")
      return `error: ${agent.name}'s job "${current.name}" is still ${current.status === "asking" ? "waiting on an answer" : "working"}. Nothing was started: send this to it without --new.`;
    return start(agent.name, brief);
  };
  const business = (): Business => ({ agents: agents.map((a) => `- ${a.name} (agents/${a.slug}, light): ${AGENTS.find((l) => l.includes(`agents/${a.slug},`))?.split("): ")[1] ?? "made today"}`), threads: [...jobs].reverse().map(line) });

  // the files jobs reported are there, so a look at one finds it
  const made: string[] = [];
  const look = (command: string) => {
    if (!made.length) return null;
    if (/\bemplio files\b|^\s*(ls|find)\b/.test(command)) return made.join("\n");
    const file = made.find((f) => command.includes(f.split("/").at(-1)!));
    return file ? `${file}: the job's file, as its report describes it` : null;
  };
  let chat: ModelMessage[] = [];
  const steps: StepResult[] = [];
  for (const [i, step] of scenario.steps.entries()) {
    let message: string;
    if ("person" in step) message = step.person;
    else {
      // the report's job: the agent's latest, or the latest handed off; one that was never started is made up so the
      // conversation goes on (the step that should have started it is already marked wrong)
      const r = step.report;
      const j = (r.from === "latest" ? lastJob : latestOf(r.from)) ?? (start(r.from === "latest" ? "Data Entry" : r.from, "(work)"), jobs.at(-1)!);
      j.status = /^\W*question\b/i.test(r.text) ? "asking" : "done";
      made.push(...(r.text.match(/\/work\/\S+\.\w+/g) ?? []));
      const full = `${head(j)}: ${j.status}, 14 actions\n${r.text}${r.apps ? `\nApps, as recorded: ${r.apps}` : ""}`;
      message = reportsNote([full], jobs.filter((x) => x !== j && x.status === "working").map((x) => x.name), j.status === "asking");
    }
    routes = [];
    let byHand = 0;
    let browser = false;
    const said = await reply(
      business(),
      [...chat, person(message)],
      (command) => {
        if (/\bemplio hand\b/.test(command)) return hand(command);
        if (/\bemplio threads (list|show)\b/.test(command)) return jobs.length ? jobs.map((j) => `${head(j)}: ${j.status}`).join("\n") : "You haven't handed anything off yet.";
        if (/\bemplio threads wait\b/.test(command)) return "Not in a chat with the person: end your reply now, in a line. Their reports come to this chat when they finish.";
        const nth = notCounted(command) ? 0 : ++byHand;
        if (/\bemplio browser\b/.test(command.split("<<")[0]!)) browser = true;
        const refused = refusal(command, nth);
        if (refused) return refused;
        const result = [look(command) ?? pretend(command), skillNote(nth, command)].filter(Boolean).join("\n\n");
        return nth && remindAt(nth) ? `${result}\n\n${longRunNote(nth, false)}` : result;
      },
      12,
    );
    chat = [...chat, person(message), ...(said.messages ?? [{ role: "assistant", content: said.text }])];
    // what the person sees: its words, and the questions it put on cards
    const shown = [said.text, ...said.commands.filter((c) => /\bemplio ask\b/.test(c))].join("\n");
    steps.push({ step: i + 1, ...check(step.expect, routes, shown, said.text, byHand), routes, byHand, browser, said: shown.slice(0, 400), usage: said.usage });
  }
  return { steps };
}

export function check(expect: Expect, routes: Route[], shown: string, text = shown, own = 0): { ok: boolean; why: string[] } {
  if (expect.anyOf) {
    const tries = expect.anyOf.map((e) => check(e, routes, shown, text, own));
    return tries.find((t) => t.ok) ?? { ok: false, why: [tries.map((t) => t.why.join("; ")).join(" | or | ")] };
  }
  const why: string[] = [];
  const silent = !text.replace("[SILENT]", "").trim() || text.includes("[SILENT]");
  if (expect.silent !== undefined && silent !== expect.silent) why.push(expect.silent ? "spoke when it had nothing to tell" : "stayed silent with a result to tell");
  if (expect.own !== undefined && own > expect.own) why.push(`ran ${own} commands itself (at most ${expect.own})`);
  if (expect.none && routes.length) why.push(`handed off (${routes.map((r) => r.agent).join(", ")}) when it should answer`);
  const left = [...routes];
  for (const want of expect.hand ?? []) {
    const fits = (r: Route) => r.agent !== "myself" && (!want.agent || want.agent.includes(r.agent)) && (want.cont === undefined || r.cont === want.cont);
    const r = left.find(fits);
    if (!r) {
      why.push(`wanted ${want.agent?.join("/") ?? "an agent"}${want.cont === undefined ? "" : want.cont ? " (carry on)" : " (fresh)"}, got ${routes.map((x) => `${x.agent}${x.cont ? " (carry on)" : " (fresh)"}`).join(", ") || "nothing"}`);
      continue;
    }
    left.splice(left.indexOf(r), 1);
    const missing = (want.say ?? []).filter((w) => !new RegExp(w, "i").test(r.brief));
    if (missing.length) why.push(`brief lost: ${missing.join(", ")}`);
  }
  const unsaid = (expect.tell ?? []).filter((w) => !new RegExp(w, "i").test(shown));
  if (unsaid.length) why.push(`didn't tell: ${unsaid.join(", ")}`);
  return { ok: !why.length, why };
}

async function task(input: Input): Promise<Output> {
  const output = await run(input).catch((e: Error) => {
    console.error(`${input.scenario.name}: ${e.stack ?? e}`);
    throw e;
  });
  if (process.env.EVAL_DUMP) appendFileSync(process.env.EVAL_DUMP, `${JSON.stringify({ name: input.scenario.name, output })}\n`);
  return output;
}

type Args = { output: Output };
const stepsRight = ({ output }: Args) => ({ name: "steps_right", score: output.steps.filter((s) => s.ok).length / output.steps.length });
const allRight = ({ output }: Args) => ({ name: "all_right", score: output.steps.every((s) => s.ok) ? 1 : 0 });
const noBrowser = ({ output }: Args) => ({ name: "no_browser", score: output.steps.some((s) => s.browser) ? 0 : 1 });

Eval<Input, Output, void>("Emplio", {
  experimentName: process.env.EVAL_EXPERIMENT || "workday",
  data: async () => {
    const { THREADS_HEADING } = (await app())[2];
    const carriesOn = THREADS_HEADING.includes("--new");
    return (await import("./scenarios")).scenarios().map((scenario) => ({ input: { scenario, carriesOn }, metadata: { name: scenario.name } }));
  },
  task,
  scores: [stepsRight, allRight, noBrowser],
  trialCount: Number(process.env.EVAL_TRIALS) || 3,
  maxConcurrency: 6,
  metadata: { behaviour: "workday", model: process.env.EVAL_MODEL || MODEL_SETS.save.chatModel },
});

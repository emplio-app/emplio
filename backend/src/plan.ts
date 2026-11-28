// The checklist: for a job of several steps, the agent keeps a list of them (`emplio plan`) and the person
// watches it fill in, in the chat (a card) and on their phone (one message, edited). One per chat, on its
// conversations row. Each command that changes it puts the whole list in its output for the chat to draw.
import type { PlanStep } from "@emplio/shared";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { conversations } from "./db/schema";

const MAX_STEPS = 30;
const MARK = { todo: "[ ]", doing: "[>]", done: "[x]" } as const;

const USAGE = `usage: emplio plan                              the checklist the person sees
       emplio plan set "step one" "step two"   a new one, each step its own argument (or one step per line from
                                               stdin: emplio plan set <<'EOF' ... EOF); start a step with [x] if it's done already
       emplio plan add <step>                  one more step at the end
       emplio plan doing <n>                   step n is what you're on now
       emplio plan done <n>...                 steps done and checked (the next one becomes the one you're on)
       emplio plan done                        all the work's done: every step ticked
       emplio plan update <n> <step>           reword step n
       emplio plan remove <n>                  drop step n (failed or not needed after all)
       emplio plan clear                       no checklist`;

export const planText = (steps: PlanStep[]) =>
  steps.length
    ? [`Checklist, ${steps.filter((s) => s.status === "done").length} of ${steps.length} done:`, ...steps.map((s, i) => `${i + 1}. ${MARK[s.status]} ${s.text}`)].join("\n")
    : "No checklist.";

// What a command may not do to a job still under way: wipe it. (`plan done` with no number is the agent saying the
// work is finished, so it ticks everything left, steps never reached included.) Asking the person
// something, or a side topic, isn't the job being done; the list is what brings Emplio back to it (unfinishedNote).
export function blocked(sub: string | undefined, rest: string[], steps: PlanStep[]) {
  const left = steps.filter((s) => s.status !== "done");
  if (sub === "set" && left.length)
    return `error: this checklist isn't finished (${left.length} left, next: "${left[0]!.text}"), so it stays. Same job: emplio plan update or add. Something new while it waits: emplio plan add. Only if it was finished or dropped, tick its steps by number or emplio plan clear, then set.`;
  return null;
}

// For the note on each of their messages (chat.ts), while a job has steps left: short, because it's sent every time.
export function unfinishedNote(steps: PlanStep[] | null | undefined) {
  const left = (steps ?? []).filter((s) => s.status !== "done");
  return left.length ? `Unfinished checklist, ${left.length} of ${steps!.length} steps left. Next: ${left[0]!.text}` : "";
}

// After a change: at most one step in progress, and if none is, the first one not done yet.
export function settle(steps: PlanStep[], doing?: number) {
  const keep = doing ?? steps.findIndex((s) => s.status === "doing");
  steps.forEach((s, i) => s.status === "doing" && i !== keep && (s.status = "todo"));
  if (!steps.some((s) => s.status === "doing")) {
    const next = steps.find((s) => s.status === "todo");
    if (next) next.status = "doing";
  }
  return steps;
}

// `emplio plan ...` in a chat; `plan`: the whole list when it changed, for the chat and the phone to show.
// after each change while steps are open (the evals show the same)
export const PLAN_TIP = "[The person is watching this list: keep it current as you work. Before you start a step: `emplio plan doing <n>` (one at a time). The moment it's finished: `emplio plan done <n>`, never several together at the end. Stopping to ask them something, leave the rest open.]";

export async function planCommand(conversationId: string, args: string[]): Promise<{ text: string; plan?: PlanStep[] }> {
  const [sub, ...rest] = args;
  const row = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId), columns: { plan: true } });
  const steps: PlanStep[] = structuredClone(row?.plan ?? []);
  const at = (ref?: string) => {
    const n = Number(ref);
    return Number.isInteger(n) && n >= 1 && n <= steps.length ? n - 1 : null;
  };
  const bad = (ref?: string) => ({ text: `error: there's no step ${ref ?? "(none given)"}; the checklist has ${steps.length}. See emplio plan.` });
  const no = blocked(sub, rest, steps);
  if (no) return { text: no };
  let next: PlanStep[];
  switch (sub) {
    case undefined:
    case "list":
    case "show":
      return { text: planText(steps) };
    case "set": {
      const lines = (rest.join("\n") || "").split("\n").map((l) => l.trim().replace(/^(\d+[.)]|[-*•])\s*/, "")).filter(Boolean);
      if (!lines.length) return { text: USAGE };
      next = lines.map((l) => {
        const done = /^\[x\]\s*/i.test(l);
        return { text: l.replace(/^\[[ x>]?\]\s*/i, "").slice(0, 200), status: done ? "done" : "todo" };
      });
      break;
    }
    case "add":
      if (!rest.join(" ").trim()) return { text: USAGE };
      next = [...steps, { text: rest.join(" ").trim().slice(0, 200), status: "todo" }];
      break;
    case "doing": {
      const i = at(rest[0]);
      if (i === null) return bad(rest[0]);
      steps[i]!.status = "doing";
      next = settle(steps, i);
      break;
    }
    case "done": {
      // no number: the job's finished, including steps answered in the reply itself
      const is = rest.length ? rest.map(at) : steps.map((_, i) => i);
      if (is.some((i) => i === null)) return bad(rest[is.indexOf(null)]);
      for (const i of is) steps[i!]!.status = "done";
      next = steps;
      break;
    }
    case "update": {
      const i = at(rest[0]);
      if (i === null) return bad(rest[0]);
      if (!rest.slice(1).join(" ").trim()) return { text: USAGE };
      steps[i]!.text = rest.slice(1).join(" ").trim().slice(0, 200);
      next = steps;
      break;
    }
    case "remove": {
      const i = at(rest[0]);
      if (i === null) return bad(rest[0]);
      next = steps.filter((_, j) => j !== i);
      break;
    }
    case "clear":
      next = [];
      break;
    default:
      return { text: USAGE };
  }
  if (next.length > MAX_STEPS) return { text: `error: at most ${MAX_STEPS} steps; group small ones together.` };
  settle(next);
  await db.update(conversations).set({ plan: next.length ? next : null }).where(eq(conversations.id, conversationId));
  const left = next.findIndex((x) => x.status !== "done");
  const tip =
    left >= 0
      ? `\n${PLAN_TIP}`
      : "";
  return { text: planText(next) + tip, plan: next };
}

// A command the agent says is for step `n` (bash's `step`): that step is now the one being worked on, and the
// one it was on before, if earlier, is done. So the list moves as the work does, even if it forgets to tick.
// `moved`: the list changed; `open`: steps still not done (the agent is reminded to tick them at the end).
export async function reachStep(conversationId: string, n: number) {
  const row = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId), columns: { plan: true } });
  const steps = structuredClone(row?.plan ?? []);
  const i = n - 1;
  const open = steps.filter((s) => s.status !== "done").length;
  if (!steps[i] || steps[i].status !== "todo") return { moved: null, open };
  const was = steps.findIndex((s) => s.status === "doing");
  if (was >= 0 && was < i) steps[was]!.status = "done";
  steps[i].status = "doing";
  settle(steps, i);
  await db.update(conversations).set({ plan: steps }).where(eq(conversations.id, conversationId));
  return { moved: steps, open: steps.filter((s) => s.status !== "done").length };
}

// How a background round is marked, by code, from the commands it chose.
// Its rules are src/heartbeat.ts (backgroundBrief, NOTES): change one, change the other.
import type { Said } from "../emplio";
import { savedOf } from "../skills/scorers";
import type { Case, Does } from "./cases";

type Args = { input: unknown; output: Said; expected: Case["expect"] };
type Score = { name: string; score: number | null; metadata?: Record<string, unknown> };

// a write whose target is in the place: `> …knowledge/x.md`, `cd …knowledge… && cat > x.md`, `sed -i … knowledge/x.md`.
// Naming the place inside a note written elsewhere (the journal) doesn't count.
const wrote = (c: string, place: RegExp) => {
  const at = place.source;
  return new RegExp(`(>>?|\\btee\\b(\\s+-a)?)\\s*["']?\\S*(${at})|\\bcd\\s+\\S*(${at})[^\\n]*(>|\\btee\\b)|\\b(sed|perl) -p?i[^\\n]*(${at})`).test(c);
};
// what the round did with the notes
export const didOf = (commands: string[]): Does[] => [
  ...(savedOf(commands).length ? (["skill"] as const) : []),
  ...(commands.some((c) => wrote(c, /knowledge\//)) ? (["knowledge"] as const) : []),
  // onto the person (`emplio person`), or for a rule about every chat, into the business's standing instructions
  ...(commands.some((c) => /\bemplio person\s+(\S+\s+)?(prefer|profile)\b/.test(c) || wrote(c, /AGENT\.md|preferences\.md/)) ? (["preference"] as const) : []),
  ...(commands.some((c) => /\bemplio tasks add\b/.test(c)) ? (["task"] as const) : []),
];

// The main number: everything the notes called for went where it belongs; with no notes, nothing was saved
// (a task for itself is fine: the check-in's own look-around may need one).
export function rightCall({ output, expected }: Args): Score {
  const did = didOf(output.commands);
  const missing = expected.does.filter((d) => !did.includes(d));
  // nothing to file: saving anything is noise (a case about tasks, memory or goals may file what it moves)
  const e = expected as Case["expect"];
  const other = !!(e.done || e.open || e.cancelled || e.rewrite || e.goals);
  const extra = expected.does.length || other ? [] : did.filter((d) => d !== "task");
  // a changed fact: the old one is marked replaced, or edited where it stands, not left beside the new one
  const stale = !!expected.replaces && !output.commands.some((c) => wrote(c, /knowledge\//) && /replaced|\b(sed|perl) -p?i/i.test(c));
  return { name: "right_call", score: missing.length || extra.length || stale ? 0 : 1, metadata: { missing, extra, stale, did } };
}

// It never does outside work itself (emailing or messaging customers, changing data in apps): that becomes a task.
export function staysInside({ output }: Args): Score {
  const outside = output.commands.filter((c) => /\bemplio apps run \S*(send|create|update|delete)/.test(c));
  return { name: "stays_inside", score: outside.length ? 0 : 1, metadata: { outside: outside.map((c) => c.slice(0, 200)) } };
}


// --- the ideal background agent (cases.ts IDEAL) ---

const tasksDone = (cs: string[], id: string) => cs.some((c) => new RegExp(`\\bemplio tasks (done ${id}|update ${id}\\b[^\\n]*--status[ =]['"]?done)`).test(c));
const tasksDropped = (cs: string[], id: string) => cs.some((c) => new RegExp(`\\bemplio tasks (remove ${id}|update ${id}\\b[^\\n]*--status[ =]['"]?cancelled)`).test(c));
// the new file a person rewrite sent: its heredoc, or the text given as the last word
export const rewriteOf = (cs: string[], email: string, file: string) => {
  const head = (c: string) => c.split("\n")[0]!.replace(/['"]/g, "");
  const [one, two] = [`emplio person ${email} rewrite ${file}`, `emplio person rewrite ${email} ${file}`];
  // the owner's own preferences are also on the computer, at me/: written whole there counts too
  const own = file === "prefer" ? /^\s*cat > \/work\/me\/preferences\.md <<'EOF'\n/ : /^\s*cat > \/work\/me\/profile\.md <<'EOF'\n/;
  const c = [...cs].reverse().find((c) => head(c).trim().startsWith(one) || head(c).trim().startsWith(two) || own.test(c));
  if (!c) return null;
  const doc = /<<'EOF'\n([\s\S]*)\nEOF\s*$/.exec(c);
  if (doc) return doc[1]!;
  // from a file it wrote first: `... rewrite prefer < /work/tmp/p.md`
  const from = /<\s*(\S+)/.exec(head(c))?.[1];
  if (from) {
    const made = [...cs].reverse().find((w) => new RegExp(`^\\s*cat > ${from.replace(/[.]/g, "\\.")} <<'EOF'\\n`).test(w));
    return made ? /<<'EOF'\n([\s\S]*)\nEOF\s*$/.exec(made)?.[1] ?? null : null;
  }
  // the text as the last word, quoted, possibly over many lines
  return c.slice(c.search(new RegExp(`\\b${file}\\b`)) + file.length).trim().replace(/^'|'$/g, "");
};
// goals.md as a round wrote it, whole (python writes show as cat > …goals.md <<'EOF')
const goalsWritten = (cs: string[]) => cs.filter((c) => wrote(c, /goals\.md/));

// Everything the case asks beyond filing (Ideal in cases.ts); cases that ask nothing more aren't marked.
export function ideal({ output, expected }: Args): Score {
  const cs = output.commands;
  const e = expected as Case["expect"];
  if (!e.done && !e.open && !e.cancelled && !e.rewrite && !e.goals) return { name: "ideal", score: null };
  const wrong: string[] = [];
  for (const id of e.done ?? []) if (!tasksDone(cs, id)) wrong.push(`${id} not marked done`);
  for (const id of e.open ?? []) if (tasksDone(cs, id) || tasksDropped(cs, id)) wrong.push(`${id} closed but still open`);
  for (const group of e.cancelled ?? []) {
    const dropped = group.filter((id) => tasksDropped(cs, id) || tasksDone(cs, id));
    if (dropped.length !== group.length - 1) wrong.push(`of ${group.join("/")}, ${dropped.length} closed (one should stay)`);
  }
  if (e.rewrite) {
    const r = e.rewrite;
    const text = rewriteOf(cs, r.email, r.file);
    if (text === null) wrong.push(`${r.file} not rewritten`);
    else {
      if (text.length > r.max) wrong.push(`rewrite is ${text.length} characters (at most ${r.max})`);
      for (const k of r.keep) if (!new RegExp(k, "i").test(text)) wrong.push(`lost: ${k}`);
      for (const d of r.drop ?? []) if (new RegExp(d, "i").test(text)) wrong.push(`kept: ${d}`);
      for (const o of r.once ?? []) {
        const n = text.split("\n").filter((l) => new RegExp(o, "i").test(l)).length;
        if (n > 1) wrong.push(`${n} lines about "${o}"`);
      }
    }
  }
  if (e.goals) {
    const written = goalsWritten(cs);
    if (!written.length) wrong.push("no progress written to goals.md");
    const last = written.at(-1) ?? "";
    // a whole-file write must keep every goal as it was; an append (>>) can't touch them
    if (last && !/>>/.test(last)) for (const h of e.goals.headings) if (!last.includes(`## ${h}`)) wrong.push(`goal changed or dropped: ${h}`);
    const added = cs.filter((c) => /\bemplio tasks add\b/.test(c)).length;
    if (added < e.goals.tasks) wrong.push(`${added} tasks added (at least ${e.goals.tasks})`);
  }
  return { name: "ideal", score: wrong.length ? 0 : 1, metadata: { wrong } };
}

// Never the browser in a background round (the server refuses it: sandbox.ts runBash).
export function noBrowser({ output }: Args): Score {
  const used = output.commands.filter((c) => /\b(emplio|ez)["']?[\s,.]+["']?browser\b/.test(c));
  return { name: "no_browser", score: used.length ? 0 : 1, metadata: { used: used.map((c) => c.slice(0, 120)) } };
}

// Everything it needs is in the round's message: few model steps (each one re-reads the whole prompt, so steps are
// what a round costs). A check-in at most 8 (the old prompt's average), the daily cleanup 10, the weekly goals
// review 15 (it digs into the numbers). Older dumps without steps: commands, at most 15 and 20.
export function lean({ output, expected }: Args): Score {
  const e = expected as Case["expect"];
  const big = !!(e.done || e.open || e.cancelled || e.rewrite || e.goals);
  const steps = (output as { steps?: number }).steps;
  const [used, most] = steps === undefined ? [output.commands.length, big ? 20 : 15] : [steps, e.goals ? 15 : big ? 10 : 8];
  return { name: "lean", score: used <= most ? 1 : 0, metadata: { [steps === undefined ? "commands" : "steps"]: used, most } };
}

export const scorers = [rightCall, staysInside, ideal, noBrowser, lean];

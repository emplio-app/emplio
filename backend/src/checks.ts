// Checks on a job's last run before its report counts (jobs.ts), all in code, no model: how the run ended, the
// shape of its report, and a Done its checklist or last command says isn't. Each failed check sends the job one short
// message to put it right, at most MAX_PUSHES times a piece of work. Whether the report proves each part is the
// manager's to judge as it reads it. From OpenClaw (incomplete-turn recovery), Hermes (stall guards, execution
// discipline) and Claude Code (checking with real output, not claims).

export const MAX_PUSHES = 3;

// How the run's last step ended, from chat.ts: its text, whether it only thought, and why the model stopped
export type Ending = { text: string; reasoned: boolean; finishReason?: string };

// its last sentence only says what it will do: "The files tie out. Next I'll compute the balances."
export const announces = (text: string) => {
  const last = text.trim().split(/\n|(?<=[.!])\s+/).filter((l) => l.trim()).at(-1)?.trim() ?? "";
  return text.length < 600 && !text.trim().endsWith("?") && !/\b(once|when|after|if) (you|they|he|she|it'?s|the)\b/i.test(last) && /^(next,? i(?:'|’)?ll|now i(?:'|’)?ll|i(?:'|’)?ll now|let me|i(?:'|’)?m going to|next i will)\b/i.test(last);
};
// code written into the message instead of run: a fenced block, or a line calling the emplio library
const textCall = (text: string) => /```(?:python|py|bash|sh)?\s*\n[\s\S]*?(emplio\.|import |print\(|def )/.test(text) && text.length < 4000;

export const ENDINGS = {
  empty: "Your run ended without a report. If the work is done, write your report now; if not, carry on with your commands. Don't redo what's done.",
  thought: "Your last step only thought and wrote nothing. Carry on from there: run what's next, or write your report if the work is done. Don't restart.",
  cut: "Your last message was cut off at the length limit. Write your report again, shorter: what's done, with its results and checks, and what isn't. Don't call unfinished parts done.",
  code: "You wrote code into your message instead of running it, so nothing ran. Run it with your command now, then carry on. Don't paste code into your report.",
  announced: "Your last message only said what you'd do next, without doing it. Do it now with your commands; write words only for your report, once the work is done.",
};

// a run that ended badly: what to tell it, or null
export function badEnding(e: Ending): string | null {
  const text = e.text.trim();
  if (e.finishReason === "length") return ENDINGS.cut;
  if (!text) return e.reasoned ? ENDINGS.thought : ENDINGS.empty;
  if (textCall(text)) return ENDINGS.code;
  if (announces(text)) return ENDINGS.announced;
  return null;
}

// The report's shape (jobs.ts RULES): "Status: Done|Partly done|Blocked" first, then Result, Checked, Files,
// Changed outside, Left. Fixed, so the manager can put split work together and the checker can find the proof.
export const REPORT_SHAPE = `Status: Done, Partly done or Blocked (the first line, one of these)
Result: what you did or found, with every id, path, link, amount and name exactly as it came back
Checked: for each part of your job card, how you know it's right: what you read back after sending or changing \
something, counts that tie out, totals worked out in code; a part you couldn't check, say so
Files: what you made, by name, in /work/out; or "none"
Changed outside: every email, message, post, payment or record you sent or changed, with its id or link; or "nothing"
Left: what isn't done and why (exact errors), and what a person must decide or provide; or "nothing"`;
const STATUS = /^\W*status\W*\s*(done|partly done|partly|blocked)\b/i;
export const statusOf = (report: string) => (report.trim().match(STATUS)?.[1]?.toLowerCase().replace(/^partly$/, "partly done") ?? null) as "done" | "partly done" | "blocked" | null;
export const SHAPE_NOTE = `Your report isn't in the shape asked for. Write it again (no new commands unless something is missing), exactly like this:
${REPORT_SHAPE}`;
// what's wrong with the report's shape, or null. "Question:" reports are asks, not reports
export function shapeProblem(report: string): string | null {
  const status = statusOf(report);
  if (!status) return SHAPE_NOTE;
  if (status === "done" && !/^\W*checked\W*:/im.test(report)) return SHAPE_NOTE;
  return null;
}

// A report that says Done against what the server itself knows (no model): steps of its checklist not ticked, or
// its last command failed. Asked once: the job may know better (a step dropped on the person's word, a search that
// found nothing on purpose), and says so in its report. The rest is the manager's to judge (jobs.ts MANAGER_PROMPT).
export const DONE_BUT = "Your report says Done, but ";
export function doneProblem(report: string, o: { open: string[]; lastFailed: string | null; askedBefore: boolean }): string | null {
  if (o.askedBefore || statusOf(report) !== "done") return null;
  if (o.open.length)
    return `${DONE_BUT}your checklist still has steps not ticked: ${o.open.map((s) => `"${s}"`).join(", ")}. Finish and check each one, or tick it if it's done (emplio plan done <n>) and say how you know under Checked. A step that can't be done: say so under Left and make the status Partly done.`;
  if (o.lastFailed)
    return `${DONE_BUT}your last command failed ("${o.lastFailed}"). Check that what it was for worked; if it did, say how under Checked; if not, fix it, or say so under Left and make the status Partly done.`;
  return null;
}

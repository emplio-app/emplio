// Stops a run that keeps failing, so it doesn't burn steps and money
// retrying what won't work. A command failed when it exited with an error or timed out. The same failure
// (same command, same end of output) a second time gets a warning in its output; a third time, or 8 failures
// in a row, and the run's commands are taken away, so its next step has to say in words what's blocking it.
// Exit code 1 alone isn't counted towards the 8: it's grep, test or diff saying "no match", not an error.
// One guard per run: a chat reply, or one job.

const SAME = 3;
const IN_A_ROW = 8;
// enough of the end of an output to tell one error from another, without a changing timestamp up top mattering
const TAIL = 500;

// A command that worked, run again exactly and with exactly the same result: reading what it already has
const SAME_RESULT =
  "[You ran exactly this before and got exactly this. Work from what you already have instead of reading it again.]";

const AGAIN =
  "[This command failed exactly the same way before. Don't run it again as it is: try a really different way.]";
const STOP =
  "[Stopped: commands keep failing the same way. No more commands this time: tell them plainly what you were trying to do, what's blocking it (the error, in everyday words), and what you need from them to get past it.]";

// reason: why the business is paused (credit.pausedReason)
export const outOfUsage = (reason: string) =>
  `[Stopped: usage just ran out. ${reason} No more commands this time: in your last message tell them plainly what's done, what's left, and that you'll carry on from there as soon as usage is added.]`;

export function failureGuard() {
  const seen = new Map<string, number>();
  let inARow = 0;
  let stuck = false;
  return {
    get stuck() {
      return stuck;
    },
    // ends the run's commands for another reason (usage ran out): its next step writes its last message
    end(note: string) {
      stuck = true;
      return note;
    },
    // what to add to this command's output, if anything
    check(command: string, result: { exitCode?: unknown; output?: unknown; stopped?: unknown }): string | null {
      // stopped by the person, or started in the background: nothing to judge
      if (result.stopped || typeof result.exitCode !== "number") return null;
      const key = `${command.trim().replace(/\s+/g, " ")}\0${String(result.output ?? "").slice(-TAIL)}`;
      const times = (seen.get(key) ?? 0) + 1;
      seen.set(key, times);
      if (result.exitCode === 0) return (inARow = 0), times === 3 ? SAME_RESULT : null;
      if (result.exitCode !== 1) inARow++;
      if (times >= SAME || inARow >= IN_A_ROW) return (stuck = true), STOP;
      return times === 2 ? AGAIN : null;
    },
  };
}
export type FailureGuard = ReturnType<typeof failureGuard>;

// A job that keeps working without getting anywhere: commands that succeed while its checklist (emplio plan) never
// moves. No checklist by NO_PLAN commands: asked to write one. Not moved in QUIET: told to tick what's done or say
// what's blocking. Not moved in STALLED: its commands are taken away (guard.end), so it reports where it got to, and
// whoever started it can carry it on. Commands that only manage (emplio plan, hand, ask) aren't counted.
// ponytail: counts commands, not time; a job of many tiny browser steps reaches it soonest, so STALLED is generous
const NO_PLAN = 15;
const QUIET = 40;
const STALLED = 80;
const WRITE_PLAN =
  "[That's a long job with no checklist. Write one now (emplio plan set ...), a step for each part of your job card, ticking what's done already, and keep it ticked as you go.]";
const QUIET_NOTE = `[Your checklist hasn't moved in ${QUIET} commands. Tick what's done (emplio plan done <n>). If you're going round in circles or something blocks you, stop and say so in your report.]`;
export const STALLED_NOTE = `[Stopped: ${STALLED} commands with no step of your checklist done. No more commands this time: report what's done, what's left, and what's in the way.]`;
export function progressGuard(planned: boolean) {
  let since = 0;
  let asked = planned;
  return {
    // what to add to a command's output, if anything; moved: the checklist changed with it
    check(moved: boolean, counted: boolean): string | null {
      if (moved) return (since = 0), (asked = true), null;
      if (!counted) return null;
      since++;
      if (!asked && since >= NO_PLAN) return (asked = true), WRITE_PLAN;
      if (since === QUIET) return QUIET_NOTE;
      return since >= STALLED ? STALLED_NOTE : null;
    },
  };
}

// A run's prepareStep, with its commands taken away once the guard says it's stuck.
export const unlessStuck =
  <A, R extends object>(prepareStep: (a: A) => Promise<R>, guard: FailureGuard) =>
  async (a: A) => {
    const step = await prepareStep(a);
    return guard.stuck ? { ...step, toolChoice: "none" as const, activeTools: [] } : step;
  };

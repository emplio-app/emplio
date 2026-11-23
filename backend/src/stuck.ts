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

// A job's checklist (emplio plan) going stale: every EVERY commands without it moving, a reminder to write one or
// tick what's done (as Claude Code reminds about its to-do list). Never stops the job: its time limit and the
// failure guard do that. Commands that only manage (emplio plan, hand, ask) aren't counted.
const EVERY = 10;
const WRITE_PLAN = "[Reminder: no checklist yet. If this takes more than a few steps, write one (emplio plan set ...), ticking what's done already.]";
const TICK = "[Reminder: your checklist hasn't moved in a while. Tick what's done (emplio plan done <n>) and keep the rest up to date.]";
export function progressGuard(planned: boolean) {
  let since = 0;
  let has = planned;
  return {
    // what to add to a command's output, if anything; moved: the checklist changed with it
    check(moved: boolean, counted: boolean): string | null {
      if (moved) return (since = 0), (has = true), null;
      if (!counted || ++since % EVERY) return null;
      return has ? TICK : WRITE_PLAN;
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

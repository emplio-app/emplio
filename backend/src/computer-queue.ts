// The cloud's computers awake at once are capped by the provider's plan, and one started past that fails. So a start
// waits its turn here: a person waiting in a live chat first, then jobs, automations and tasks, then check-ins and
// briefs, first come first served within each. sandbox.ts says how many are awake (countAwake).
// ponytail: in memory, one server process; a start the provider still refuses as full (a preview link woke one, a
// restart forgot what was awake) goes back in line
const CAP = Number(process.env.COMPUTER_MAX ?? 18);
const FULL_PAUSE_MS = 15_000;

export const PRIORITY = { person: 0, work: 1, background: 2 } as const;

export class ComputersBusy extends Error {
  constructor() {
    super("every computer is busy right now: try again in a minute");
  }
}

// the provider's own "too many at once"
export const isFull = (error: unknown) => /maximum number of concurrent|concurrent .*sandboxes|\b429\b/i.test(error instanceof Error ? error.message : String(error));

type Waiter = { priority: number; seq: number; go: () => void };
const waiting: Waiter[] = [];
let seq = 0;
let starting = 0;
let awakeNow = () => 0;
export const countAwake = (fn: () => number) => void (awakeNow = fn);

function pump(cap = CAP) {
  waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  while (waiting.length && awakeNow() + starting < cap) {
    starting++;
    waiting.shift()!.go();
  }
}
// computers fall asleep without telling anyone: look again now and then
setInterval(() => pump(), 10_000).unref?.();

function turn(priority: number, until: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const me: Waiter = { priority, seq: seq++, go: () => (clearTimeout(timer), resolve()) };
    const leave = (error: Error) => {
      const at = waiting.indexOf(me);
      if (at < 0) return;
      waiting.splice(at, 1);
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => leave(new ComputersBusy()), Math.max(0, until - Date.now()));
    signal?.addEventListener("abort", () => leave(new Error("stopped")), { once: true });
    waiting.push(me);
    pump();
  });
}

// start() once there's room; it must count its computer as awake (countAwake) before it returns.
export async function withComputer<T>(priority: number, waitMs: number, start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const until = Date.now() + waitMs;
  for (;;) {
    await turn(priority, until, signal);
    try {
      return await start();
    } catch (error) {
      if (!isFull(error)) throw error;
      if (Date.now() + FULL_PAUSE_MS > until) throw new ComputersBusy();
    } finally {
      starting--;
      pump();
    }
    await Bun.sleep(FULL_PAUSE_MS);
  }
}

// for tests
export const queued = () => waiting.length;
export const recheck = () => pump();

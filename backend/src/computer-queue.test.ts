import { expect, test } from "bun:test";
import { ComputersBusy, countAwake, isFull, PRIORITY, queued, recheck, withComputer } from "./computer-queue";

test("at the cap, starts wait their turn: a person first, then work, then briefs, oldest first", async () => {
  let awake = 18;
  countAwake(() => awake);
  const order: string[] = [];
  const start = (name: string) => () => {
    order.push(name);
    awake++;
    return Promise.resolve(name);
  };
  const brief = withComputer(PRIORITY.background, 60_000, start("brief"));
  const job1 = withComputer(PRIORITY.work, 60_000, start("job1"));
  const job2 = withComputer(PRIORITY.work, 60_000, start("job2"));
  const chat = withComputer(PRIORITY.person, 60_000, start("chat"));
  await Bun.sleep(5);
  expect(order).toEqual([]);
  expect(queued()).toBe(4);
  // two fall asleep: two go, in order
  awake -= 2;
  recheck();
  await Bun.sleep(5);
  expect(order.slice(0, 2)).toEqual(["chat", "job1"]);
  awake = 0;
  recheck();
  await Promise.all([brief, job1, job2, chat]);
  expect(order).toEqual(["chat", "job1", "job2", "brief"]);
});

test("a start waits no longer than its limit, and a provider that says full puts it back in line", async () => {
  countAwake(() => 18);
  await expect(withComputer(PRIORITY.person, 20, () => Promise.resolve(1))).rejects.toBeInstanceOf(ComputersBusy);
  expect(queued()).toBe(0);
  countAwake(() => 0);
  expect(isFull(new Error("429: Rate limit exceeded, you have reached the maximum number of concurrent sandboxes (20)"))).toBe(true);
  expect(isFull(new Error("could not reach the computer"))).toBe(false);
  // full, with no time to wait again: busy, not the provider's error
  await expect(withComputer(PRIORITY.work, 1_000, () => Promise.reject(new Error("maximum number of concurrent sandboxes")))).rejects.toBeInstanceOf(ComputersBusy);
  await expect(withComputer(PRIORITY.work, 1_000, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
});

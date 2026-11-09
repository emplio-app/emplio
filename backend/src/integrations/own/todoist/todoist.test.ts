import { afterEach, beforeAll, expect, test } from "bun:test";
import { pollOnce } from "../../polls";
import { AppsError } from "../../types";
import { own } from "../index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a token is checked and labelled, a bad one is refused", async () => {
  let at = "";
  let auth = "";
  globalThis.fetch = (async (u: string, init: RequestInit) => ((at = u), (auth = (init.headers as any).Authorization), json({ full_name: "Asha" }))) as typeof fetch;
  expect(await own.connectWithKey!("todoist", "tok")).toEqual({ secret: "tok", label: "Asha" });
  expect(at).toBe("https://api.todoist.com/api/v1/user");
  expect(auth).toBe("Bearer tok");
  globalThis.fetch = (async () => json({ error: "Forbidden" }, 401)) as unknown as typeof fetch;
  await expect(own.connectWithKey!("todoist", "no")).rejects.toBeInstanceOf(AppsError);
});

test("reads run unasked, writes ask, and the names automations use are kept", async () => {
  expect((await own.getAction("todoist.get_all_tasks"))?.readOnly).toBe(true);
  expect((await own.getAction("todoist.create_task"))?.readOnly).toBe(false);
  expect((await own.getAction("todoist.close_task"))?.readOnly).toBe(false);
  expect((await own.getAction("todoist.sync"))?.readOnly).toBe(false);
});

test("a task goes as JSON to the right place", async () => {
  let call: { u: string; body: string } | undefined;
  globalThis.fetch = (async (u: string, init: RequestInit) => ((call = { u, body: String(init.body) }), json({ id: "1" }))) as typeof fetch;
  await own.run("todoist.create_task", { content: "Call Asha", labels: ["sales"] }, { externalId: "c", secret: "t" }, "o");
  expect(call!.u).toBe("https://api.todoist.com/api/v1/tasks");
  expect(JSON.parse(call!.body)).toEqual({ content: "Call Asha", labels: ["sales"] });
});

const runner = (tasks: unknown[]) => async () => ({ results: tasks, next_cursor: null });
const task = (id: string, extra = {}) => ({ id, labels: [], added_at: new Date().toISOString(), ...extra });

test("new tasks: the first check only notes, and Composio's trigger name works the same", async () => {
  for (const trigger of ["todoist.new_task", "todoist.new_task_created"]) {
    const first = await pollOnce(trigger, {}, null, runner([task("a")]));
    expect(first.fresh).toEqual([]);
    const next = await pollOnce(trigger, {}, first.seen, runner([task("a"), task("b", { project_id: "p" })]));
    expect((next.fresh[0] as any).task.id).toBe("b");
    expect((await pollOnce(trigger, { project_id: "q" }, first.seen, runner([task("b", { project_id: "p" })]))).fresh).toEqual([]);
  }
});

test("completed tasks are read from the last day, and comments from what's watched", async () => {
  const sent: any[] = [];
  const first = await pollOnce("todoist.task_completed", { project_id: "p" }, [], async (_a, i) => (sent.push(i), { items: [{ id: "t1" }] }));
  expect(first.fresh).toEqual([{ task: { id: "t1" } }]);
  expect(sent[0].project_id).toBe("p");
  expect(Date.parse(sent[0].until) - Date.parse(sent[0].since)).toBe(86_400_000);
  const c = await pollOnce("todoist.new_comment", { task_id: "t" }, [], async (_a, i) => (sent.push(i), { results: [{ id: "c1" }] }));
  expect(c.fresh).toEqual([{ comment: { id: "c1" } }]);
  expect(sent[1]).toEqual({ limit: 200, task_id: "t" });
});

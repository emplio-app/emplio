import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { pollOnce } from "../../polls";
import { AppsError } from "../../types";
import { own } from "../index";
import { events, triggers, wanted } from "./triggers";
import { productive } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/vnd.api+json; charset=utf-8" } });
type Call = { url: string; method: string; body: any; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url: decodeURIComponent(String(url)), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const KEY = "4242:tok_abc";
const login = { externalId: "c1", secret: KEY };
const token = (event: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`productive-webhook:c1:${event}`).digest("hex");
const target = (event: string) => `https://api.test/webhooks/app/productive/c1/${event}/${token(event)}`;
const hook = (event: string, extra = {}) => ({ id: "w9", type: "webhooks", attributes: { target_url: target(event), event_id: Number(event), signature_token: "sig-secret", deactivated_at: null, ...extra } });
const signed = (body: string, secret = "sig-secret", t = "1700000000") => `t=${t} s=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const delivery = (payload: unknown, event = "1", sig?: string, rest = `${event}/${token(event)}`) => {
  const body = JSON.stringify(payload);
  return { body, headers: { "productive-signature": sig ?? signed(body) }, connection: "c1", rest };
};
const task = { object: { data: { id: "77", type: "tasks", attributes: { title: "Send the brief", updated_at: "2026-11-22T10:00:00Z" }, relationships: { project: { data: { type: "projects", id: "5" }, meta: { included: false } }, assignee: { data: { type: "people", id: "9" } }, subscribers: { data: [{ type: "people", id: "1" }, { type: "people", id: "2" }] }, creator: { meta: { included: false } } } } } };

test("a key is the organization id and token in either order, sent as Productive's headers, and labelled with the organization", async () => {
  const calls = stub(() => json({ data: { id: "4242", type: "organizations", attributes: { name: "Northwind" } } }));
  expect(await own.connectWithKey!("productive", " tok_abc:4242 ")).toEqual({ secret: "tok_abc:4242", label: "Northwind" });
  expect(calls[0]!.url).toBe("https://api.productive.io/api/v2/organizations/4242");
  expect(calls[0]!.headers).toMatchObject({ "X-Auth-Token": "tok_abc", "X-Organization-Id": "4242", "Content-Type": "application/vnd.api+json" });
});

test("a key without both parts, or a refused token, is turned down", async () => {
  await expect(own.connectWithKey!("productive", "tok_abc")).rejects.toThrow(/organization id/);
  stub(() => json({ errors: [{ status: "401", title: "Unauthorized" }] }, 401));
  const refused = await own.connectWithKey!("productive", KEY).catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("reads run unasked, writes ask, and the webhook secrets ask", async () => {
  expect((await own.getAction("productive.list_tasks"))?.readOnly).toBe(true);
  expect((await own.getAction("productive.get_deal"))?.readOnly).toBe(true);
  expect((await own.getAction("productive.create_task"))?.readOnly).toBe(false);
  expect((await own.getAction("productive.delete_invoice"))?.readOnly).toBe(false);
  expect((await own.getAction("productive.list_webhooks"))?.readOnly).toBe(false);
  expect((await own.getAction("productive.check_export_status_invoice"))?.readOnly).toBe(true);
  expect(Object.keys(productive.actions).length).toBeGreaterThan(800);
  // every generated input builds
  for (const a of Object.values(productive.actions)) expect(a.input).toBeDefined();
});

test("filters go as filter[...] and lists comma separated", async () => {
  const calls = stub(() => json({ data: [] }));
  await own.run("productive.list_tasks", { filter: { project_id: "5", due_date: { lt: "2026-12-01" }, assignee_id: ["1", "2"] }, sort: ["-created_at"], include: ["project", "assignee"], "page[size]": 50 }, login, "o");
  const url = new URL(calls[0]!.url);
  expect(url.pathname).toBe("/api/v2/tasks");
  expect(Object.fromEntries(url.searchParams)).toEqual({ "filter[project_id]": "5", "filter[due_date][lt]": "2026-12-01", "filter[assignee_id]": "1,2", sort: "-created_at", include: "project,assignee", "page[size]": "50" });
});

test("a create is sent as JSON:API, with links as relationships", async () => {
  const calls = stub(() => json({ data: { id: "77", type: "tasks" } }, 201));
  await own.run("productive.create_task", { title: "Send the brief", due_date: "2026-12-01", project_id: "5", task_list_id: 8, assignee_id: "9", subscriber_ids: ["1", "2"], include: ["project"] }, login, "o");
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toBe("https://api.productive.io/api/v2/tasks?include=project");
  expect(calls[0]!.body).toEqual({
    data: {
      type: "tasks",
      attributes: { title: "Send the brief", due_date: "2026-12-01" },
      relationships: {
        project: { data: { type: "projects", id: "5" } },
        task_list: { data: { type: "task_lists", id: "8" } },
        assignee: { data: { type: "people", id: "9" } },
        subscribers: { data: [{ type: "people", id: "1" }, { type: "people", id: "2" }] },
      },
    },
  });
});

test("an update carries its id; a bulk call says so in its content type", async () => {
  const calls = stub(() => json({ data: {} }));
  await own.run("productive.update_task", { id: "77", title: "Renamed" }, login, "o");
  expect(calls[0]!.method).toBe("PATCH");
  expect(calls[0]!.url).toBe("https://api.productive.io/api/v2/tasks/77");
  expect(calls[0]!.body).toEqual({ data: { type: "tasks", id: "77", attributes: { title: "Renamed" } } });
  await own.run("productive.bulk_delete_tasks", { data: [{ type: "tasks", id: "1" }] }, login, "o");
  expect(calls[1]!.method).toBe("DELETE");
  expect(calls[1]!.headers["Content-Type"]).toBe("application/vnd.api+json; ext=bulk");
  expect(calls[1]!.body).toEqual({ data: [{ type: "tasks", id: "1" }] });
  await own.run("productive.archive_project", { id: "5" }, login, "o");
  expect(calls[2]!.url).toBe("https://api.productive.io/api/v2/projects/5/archive");
  expect(calls[2]!.body).toBeUndefined();
});

test("the first automation for an event makes its webhook; the next one finds it", async () => {
  const none = stub((c) => json(c.method === "GET" ? { data: [] } : { data: hook("1") }, c.method === "GET" ? 200 : 201));
  expect(await own.startPush!("productive.task_created", login, { project_id: "5" })).toBe("productive:c1:1");
  expect(none[0]!.url).toContain("filter[event_id]=1");
  expect(none[1]!.method).toBe("POST");
  expect(none[1]!.url).toBe("https://api.productive.io/api/v2/webhooks");
  expect(none[1]!.body).toEqual({ data: { type: "webhooks", attributes: { name: "Emplio: task created", event_id: 1, target_url: target("1"), type_id: 1 } } });
  const found = stub(() => json({ data: [hook("1", { target_url: "https://elsewhere" }), hook("1")] }));
  await own.startPush!("productive.task_created", login, {});
  expect(found).toHaveLength(1);
  const off = stub(() => json({ data: [hook("1", { deactivated_at: "2026-11-01T00:00:00Z" })] }));
  await own.startPush!("productive.task_created", login, {});
  expect(off[1]!.method).toBe("PATCH");
  expect(off[1]!.url).toEndWith("/api/v2/webhooks/w9/activate");
});

test("the last automation removes the webhook, found by its URL", async () => {
  const calls = stub((c) => json(c.method === "GET" ? { data: [hook("24")] } : {}));
  await productive.push!.stop!(KEY, "productive:c1:24");
  expect(calls[1]!.method).toBe("DELETE");
  expect(calls[1]!.url).toEndWith("/api/v2/webhooks/w9");
});

test("a delivery needs our URL token and Productive's signature", async () => {
  stub(() => json({ data: [hook("1")] }));
  const receive = productive.push!.receive!;
  expect(await receive(delivery(task, "1", undefined, "1/nope"), KEY)).toBeNull();
  expect(await receive(delivery(task, "1", undefined, `24/${token("1")}`), KEY)).toBeNull();
  expect(await receive(delivery(task, "1", signed(JSON.stringify(task), "wrong")), KEY)).toBeNull();
  expect(await receive(delivery(task, "1", "nothing"), KEY)).toBeNull();
  expect(await receive(delivery(task, "1"), KEY)).not.toBeNull();
});

test("each event starts only its own trigger, with tidy data, and a retry has the same id", async () => {
  stub((c) => json({ data: [hook(new URL(c.url).searchParams.get("filter[event_id]")!)] }));
  for (const [name, event] of Object.entries(events)) {
    const got = (await (await productive.push!.receive!(delivery(task, event), KEY))!.events())[0]!;
    expect(got.triggers).toEqual([name]);
  }
  const once = (await (await productive.push!.receive!(delivery(task, "24"), KEY))!.events())[0]!;
  const again = (await (await productive.push!.receive!(delivery(task, "24", signed(JSON.stringify(task), "sig-secret", "1700000999")), KEY))!.events())[0]!;
  expect(once.id).toBe(again.id!);
  expect(once.data).toEqual({ event: "task_updated", id: "77", type: "tasks", attributes: task.object.data.attributes, relationships: { project: "5", assignee: "9", subscribers: ["1", "2"] } });
});

test("filters narrow what runs", () => {
  const data = { event: "task_created", id: "77", type: "tasks", attributes: { company_id: 3 }, relationships: { project: "5", assignee: "9", subscribers: ["1", "2"] } };
  expect(wanted({}, data)).toBe(true);
  expect(wanted({ project_id: "5" }, data)).toBe(true);
  expect(wanted({ project_id: 5, assignee_id: "9" }, data)).toBe(true);
  expect(wanted({ project_id: "6" }, data)).toBe(false);
  expect(wanted({ company_id: "3" }, data)).toBe(true);
  expect(wanted({ subscriber_id: "2" }, { ...data, relationships: { subscriber: ["1", "2"] } })).toBe(true);
  expect(triggers.task_created!.config.map((c) => c.name)).toEqual(["project_id", "assignee_id", "task_list_id"]);
  expect(Object.keys(triggers)).toHaveLength(33);
});

test("comments are polled, and only new ones start a run", async () => {
  const now = new Date().toISOString();
  const row = (id: string) => ({ id, type: "comments", attributes: { body: "hi", created_at: now } });
  const inputs: unknown[] = [];
  const first = await pollOnce("productive.comment_created", { project_id: "5" }, null, async (_a, i) => (inputs.push(i), { data: [row("1")] }));
  expect(first.fresh).toEqual([]);
  expect(inputs[0]).toEqual({ sort: ["-created_at"], "page[size]": 50, filter: { project_id: "5" } });
  const next = await pollOnce("productive.comment_created", { project_id: "5" }, first.seen, async () => ({ data: [row("2"), row("1")] }));
  expect(next.fresh).toEqual([{ comment: row("2") }]);
});

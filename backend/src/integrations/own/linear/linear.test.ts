import { afterEach, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { pollOnce } from "../../polls";
import { AppFile, AppsError } from "../../types";
import { own } from "../index";
import { linear } from "./index";
import { triggers, triggersFor, wanted, webhookSecret } from "./triggers";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.WEBHOOK_URL = "https://api.test";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: any; raw: unknown; headers: Record<string, string> };
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const raw = init.body;
    let body: any;
    try {
      body = typeof raw === "string" ? JSON.parse(raw) : undefined;
    } catch {}
    const c = { url: String(url), method: init.method ?? "GET", body, raw, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};
const login = { externalId: "c1", secret: "lin_api_x" };
const HOOK = "https://api.test/webhooks/app/linear/c1/all";

test("a key is sent as is, checked and labelled; a bad one is refused as dead", async () => {
  const calls = stub(() => json({ data: { viewer: { name: "Sarah", email: "s@northwind.test", organization: { name: "Northwind" } } } }));
  expect(await own.connectWithKey!("linear", " lin_api_x ")).toEqual({ secret: "lin_api_x", label: "Sarah (Northwind)" });
  expect(calls[0]!.url).toBe("https://api.linear.app/graphql");
  expect(calls[0]!.headers.Authorization).toBe("lin_api_x");
  stub(() => json({ errors: [{ message: "Authentication required, not authenticated", extensions: { code: "AUTHENTICATION_ERROR" } }] }, 400));
  const refused = await own.connectWithKey!("linear", "nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("every query and mutation is an action; reads run unasked, writes ask", async () => {
  expect(Object.keys(linear.actions).length).toBeGreaterThan(470);
  expect((await own.getAction("linear.list_issues"))?.readOnly).toBe(true);
  expect((await own.getAction("linear.get_issue"))?.readOnly).toBe(true);
  expect((await own.getAction("linear.run_graphql_query"))?.readOnly).toBe(true);
  for (const a of ["issue_create", "issue_update", "issue_delete", "comment_create", "webhook_create", "run_query_or_mutation", "upload_file", "create_linear_issue"])
    expect((await own.getAction(`linear.${a}`))?.readOnly).toBeFalsy();
});

test("an input object's fields are offered on their own and go back inside it", async () => {
  const fields = (await own.getAction("linear.issue_create"))!.input.map((f) => f.name);
  expect(fields).toContain("teamId");
  expect(fields).toContain("title");
  expect(fields).not.toContain("input");
  const calls = stub(() => json({ data: { issueCreate: { success: true, issue: { id: "i1", identifier: "ENG-1" } } } }));
  const out = await own.run("linear.issue_create", { teamId: "t1", title: "Call Sarah" }, login, "o");
  expect(out).toEqual({ success: true, issue: { id: "i1", identifier: "ENG-1" } });
  expect(calls[0]!.body.variables).toEqual({ input: { teamId: "t1", title: "Call Sarah" } });
  expect(calls[0]!.body.query).toStartWith("mutation issue_create($input: IssueCreateInput!) { issueCreate(input: $input) { ");
});

test("an update keeps the id apart and can clear a field", async () => {
  const calls = stub(() => json({ data: { issueUpdate: { success: true } } }));
  await own.run("linear.update_issue", { id: "ENG-1", assigneeId: null, priority: 1 }, login, "o");
  expect(calls[0]!.body.variables).toEqual({ id: "ENG-1", input: { assigneeId: null, priority: 1 } });
});

test("a read can ask for its own fields; one that breaks out of them is refused", async () => {
  const calls = stub(() => json({ data: { issue: { title: "x" } } }));
  await own.run("linear.get_issue", { id: "ENG-1", select: "title comments { nodes { body } }" }, login, "o");
  expect(calls[0]!.body.query).toBe("query get_issue($id: String!) { issue(id: $id) { title comments { nodes { body } } } }");
  await expect(own.run("linear.get_issue", { id: "ENG-1", select: "id } } mutation { issueDelete(id: \"x\") { success" }, login, "o")).rejects.toThrow(/select/);
  expect(calls).toHaveLength(1);
});

test("Linear's errors come back as errors, and a partial answer keeps them", async () => {
  stub(() => json({ data: { issue: null }, errors: [{ message: "Entity not found: Issue" }] }));
  await expect(own.run("linear.get_issue", { id: "ENG-9" }, login, "o")).rejects.toThrow("Linear: Entity not found: Issue");
  stub(() => json({ errors: [{ message: "Argument Validation Error" }] }, 400));
  await expect(own.run("linear.list_teams", {}, login, "o")).rejects.toThrow("Argument Validation Error");
  stub(() => json({ data: { issue: { id: "i1", cycle: null } }, errors: [{ message: "no access to cycle" }] }));
  expect(await own.run("linear.get_issue", { id: "ENG-1" }, login, "o")).toEqual({ id: "i1", cycle: null, errors: ["no access to cycle"] });
});

test("the read-only GraphQL action refuses changes", async () => {
  const calls = stub(() => json({ data: { viewer: { id: "u1" } } }));
  expect(await own.run("linear.run_graphql_query", { query: "{ viewer { id } }" }, login, "o")).toEqual({ viewer: { id: "u1" } });
  await expect(own.run("linear.run_graphql_query", { query: "mutation { issueDelete(id: \"x\") { success } }" }, login, "o")).rejects.toThrow(/only reads/);
  expect(calls).toHaveLength(1);
});

test("a file goes up to Linear's storage, and comes back down as a file", async () => {
  const calls = stub((c) =>
    c.url.includes("graphql")
      ? json({ data: { fileUpload: { uploadFile: { uploadUrl: "https://storage.test/put", assetUrl: "https://uploads.linear.app/a/b/c.png", headers: [{ key: "x-goog-meta", value: "1" }] } } } })
      : c.method === "PUT"
        ? new Response("", { status: 200 })
        : new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }),
  );
  const up = await own.run("linear.upload_file", { file: new AppFile("c.png", "image/png", new Uint8Array([1, 2])) }, login, "o");
  expect(up).toEqual({ assetUrl: "https://uploads.linear.app/a/b/c.png", name: "c.png" });
  expect(calls[0]!.body.variables).toEqual({ contentType: "image/png", filename: "c.png", size: 2 });
  expect(calls[1]!.headers["x-goog-meta"]).toBe("1");
  const down = (await own.run("linear.download_file", { url: "https://uploads.linear.app/a/b/c.png" }, login, "o")) as AppFile;
  expect(down).toBeInstanceOf(AppFile);
  expect(down.name).toBe("c.png");
  expect(calls[2]!.headers.Authorization).toBe("lin_api_x");
  await expect(own.run("linear.download_file", { url: "https://evil.test/x" }, login, "o")).rejects.toThrow(/uploads.linear.app/);
});

// a workspace's webhooks, then whatever the next call answers
const hooks = (list: unknown[], seen: Call[] = []) => (c: Call) => (seen.push(c), c.body?.query?.includes("webhooks(") ? json({ data: { webhooks: { nodes: list } } }) : json({ data: { webhookCreate: { success: true }, webhookUpdate: { success: true }, webhookDelete: { success: true } } }));

test("the first automation makes a signed webhook for every public team", async () => {
  const calls = stub(hooks([]));
  expect(await own.startPush!("linear.issue_created_trigger", login, {})).toBe("linear:c1:all");
  expect(calls[1]!.body.query).toContain("webhookCreate");
  expect(calls[1]!.body.variables.input).toEqual({ url: HOOK, label: "Emplio", resourceTypes: ["Issue"], secret: webhookSecret("c1"), allPublicTeams: true });
});

test("the next trigger adds its type to that webhook; one it has needs no change", async () => {
  const hook = { id: "w1", url: HOOK, enabled: true, resourceTypes: ["Issue"] };
  const add = stub(hooks([hook]));
  await own.startPush!("linear.comment_created_trigger", login, {});
  expect(add[1]!.body.query).toContain("webhookUpdate");
  expect(add[1]!.body.variables).toEqual({ id: "w1", input: { enabled: true, resourceTypes: ["Issue", "Comment"], secret: webhookSecret("c1") } });
  const none = stub(hooks([hook]));
  await own.startPush!("linear.issue_updated_trigger", login, {});
  expect(none).toHaveLength(1);
});

test("a team gets its own webhook, and audit entries theirs", async () => {
  const calls = stub(hooks([]));
  expect(await own.startPush!("linear.private_team_issue_created", login, { team_id: "team-1" })).toBe("linear:c1:team-1");
  expect(calls[1]!.body.variables.input).toMatchObject({ url: "https://api.test/webhooks/app/linear/c1/team-1", teamId: "team-1" });
  expect(await own.startPush!("linear.audit_entry_created", login, {})).toBe("linear:c1:audit");
  await expect(own.startPush!("linear.issue_created_trigger", login, { team_id: "../x" })).rejects.toThrow(/team_id/);
});

test("a key that isn't an admin's is told so", async () => {
  stub(() => json({ errors: [{ message: "Invalid scope: admin required" }] }, 400));
  await expect(own.startPush!("linear.issue_created_trigger", login, {})).rejects.toThrow(/admin/);
});

test("the last automation removes the webhook, found by its URL", async () => {
  const calls = stub(hooks([{ id: "other", url: "https://x", enabled: true, resourceTypes: [] }, { id: "w1", url: HOOK, enabled: true, resourceTypes: ["Issue"] }]));
  await linear.push!.stop!("k", "linear:c1:all");
  expect(calls[1]!.body.query).toContain("webhookDelete");
  expect(calls[1]!.body.variables).toEqual({ id: "w1" });
});

const sign = (body: string, connection = "c1") => createHmac("sha256", webhookSecret(connection)).update(body).digest("hex");
const deliver = (p: object, sig?: string, rest = "all") => {
  const body = JSON.stringify(p);
  return linear.push!.receive!({ body, headers: { "linear-signature": sig ?? sign(body), "linear-delivery": "d1" }, connection: "c1", rest }, "");
};
const issue = (action: string, extra = {}) => ({ action, type: "Issue", createdAt: "2026-11-22T10:00:00.000Z", organizationId: "o", webhookId: "w", webhookTimestamp: 1, data: { id: "i1", identifier: "ENG-1", state: { name: "Done" }, labels: [{ name: "Bug" }], assigneeId: "u1", completedAt: "2026-11-22T10:00:00.000Z" }, ...extra });

test("only Linear's signature is taken", async () => {
  expect(await deliver(issue("create"), "0".repeat(64))).toBeNull();
  expect(await deliver(issue("create"), sign(JSON.stringify(issue("create")), "other"))).toBeNull();
  expect(await linear.push!.receive!({ body: "{}", headers: {}, connection: "c1", rest: "all" }, "")).toBeNull();
  expect(await deliver(issue("create"), undefined, "../x")).toBeNull();
  const [e] = await (await deliver(issue("create")))!.events();
  expect(e!.id).toBe("d1");
  expect(e!.data).not.toHaveProperty("organizationId");
  expect((e!.data as { data: { identifier: string } }).data.identifier).toBe("ENG-1");
});

test("each event starts only the right triggers", () => {
  const t = (p: object) => triggersFor(p).sort();
  expect(t(issue("create"))).toEqual(["issue_created_trigger", "private_team_issue_created", "public_team_issue_created"]);
  expect(t(issue("update", { updatedFrom: { title: "old" } }))).toEqual(["issue_updated_trigger", "private_team_issue_properties_updated", "public_team_issue_properties_updated"]);
  expect(t(issue("update", { updatedFrom: { stateId: "s0", completedAt: null } }))).toContain("issue_status_changed_trigger");
  expect(t(issue("update", { updatedFrom: { stateId: "s0", completedAt: null } }))).toContain("issue_completed_trigger");
  expect(t(issue("update", { updatedFrom: { assigneeId: null } }))).toContain("issue_assigned_trigger");
  expect(t(issue("update", { updatedFrom: { assigneeId: null } }))).not.toContain("issue_status_changed_trigger");
  expect(t(issue("remove"))).toEqual(["issue_removed_trigger"]);
  expect(t({ type: "Comment", action: "create" })).toEqual(["comment_created_trigger", "comment_event_trigger", "private_team_comment_created", "public_team_comment_created"]);
  expect(t({ type: "ProjectUpdate", action: "create" })).toEqual(["project_update_event_trigger", "project_update_posted"]);
  expect(t({ type: "Project", action: "update" })).toEqual(["project_properties_updated"]);
  expect(t({ type: "OAuthApp", action: "revoked" })).toEqual([]);
});

test("filters narrow what runs", () => {
  const p = issue("update", { updatedFrom: { stateId: "s0" } });
  expect(wanted({}, p)).toBe(true);
  expect(wanted({ team_id: "t1" }, p)).toBe(true);
  expect(wanted({ field: "stateId" }, p)).toBe(true);
  expect(wanted({ field: "priority" }, p)).toBe(false);
  expect(wanted({ issue: "eng-1" }, p)).toBe(true);
  expect(wanted({ issue: "ENG-2" }, p)).toBe(false);
  expect(wanted({ state: "done" }, p)).toBe(true);
  expect(wanted({ label: "bug", assignee_id: "u1" }, p)).toBe(true);
  expect(wanted({ assignee_id: "u2" }, p)).toBe(false);
  expect(wanted({ action: "create" }, p)).toBe(false);
});

test("every trigger is listed with Composio's names", () => {
  for (const n of ["comment_event_trigger", "issue_created_trigger", "issue_updated_trigger", "private_team_comment_created", "private_team_issue_created", "private_team_issue_properties_updated", "project_created", "project_properties_updated", "project_update_posted", "public_team_comment_created", "public_team_issue_created", "public_team_issue_properties_updated"])
    expect(triggers[n]).toBeDefined();
});

test("polled issues: only new ones start a run, changes carry their time", async () => {
  const at = new Date().toISOString();
  const calls = stub(() => json({ data: { issues: { nodes: [{ id: "i1", updatedAt: at }], pageInfo: {} } } }));
  const run = (action: string, input: unknown) => own.run(action, input, login, "o");
  const first = await pollOnce("linear.new_issue", { team_id: "t1" }, null, run);
  expect(first.fresh).toEqual([]);
  expect(calls[0]!.body.variables.filter.team).toEqual({ id: { eq: "t1" } });
  expect(calls[0]!.body.variables.filter.createdAt.gt).toBeString();
  const changed = await pollOnce("linear.issue_changed", {}, ["i1:old"], run);
  expect(changed.fresh).toEqual([{ issue: { id: "i1", updatedAt: at } }]);
  expect(calls[1]!.body.variables.orderBy).toBe("updatedAt");
});

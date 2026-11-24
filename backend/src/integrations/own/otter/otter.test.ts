import { afterEach, expect, test } from "bun:test";
import { AppsError } from "../../types";
import { otter as polls } from "../../polls/otter";
import { otter } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
type Call = {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
  redirect?: string;
};
const stub = (answer: (c: Call) => Response) => {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = {
      url: String(url),
      method: init.method ?? "GET",
      body: String(init.body ?? ""),
      headers: init.headers as Record<string, string>,
      redirect: init.redirect,
    };
    calls.push(c);
    return answer(c);
  }) as typeof fetch;
  return calls;
};

// runs an action the way Emplio does: input checked (defaults filled) first
const run = (action: string, input: unknown = {}) => {
  const a = otter.actions[action]!;
  return a.run(a.input.parse(input), "otter_key");
};
const pollRun = (action: string, input: unknown) => run(action.replace("otter.", ""), input);
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

test("a key is checked on /workspace with a bearer token and labelled with the workspace; a bad one is refused as dead", async () => {
  const calls = stub(() => json({ meta: {}, data: { id: 42, name: "Northwind" } }));
  expect(await otter.check("otter_key")).toBe("Northwind");
  expect(calls[0]!.url).toBe("https://api.otter.ai/v1/workspace");
  expect(calls[0]!.headers.Authorization).toBe("Bearer otter_key");
  stub(() =>
    json(
      {
        errors: [{ status: "Unauthorized", code: "401", detail: "Invalid API key" }],
      },
      401,
    ),
  );
  const refused = await otter.check("nope").catch((e) => e);
  expect(refused).toBeInstanceOf(AppsError);
  expect(refused.expired).toBe(true);
});

test("a conversation comes with what was asked for, comma separated, and summary, items and outline by default", async () => {
  const calls = stub(() => json({ meta: {}, data: { id: "c1" } }));
  await run("get_conversation", { id: "c1" });
  await run("get_conversation", { id: "c1", include: ["transcript"] });
  expect(decodeURIComponent(calls[0]!.url)).toBe("https://api.otter.ai/v1/conversations/c1?include=action_items,insights,outline");
  expect(calls[1]!.url).toBe("https://api.otter.ai/v1/conversations/c1?include=transcript");
});

test("filters and the page cursor go in the query; an import posts the link", async () => {
  const calls = stub(() => json({ status: "success" }));
  await run("list_conversations", {
    channel_id: "ch1",
    limit: 5,
    cursor: "next",
  });
  expect(calls[0]!.url).toBe("https://api.otter.ai/v1/conversations?channel_id=ch1&limit=5&cursor=next");
  await run("import_recording", {
    file: "https://example.com/call.mp4",
    name: "Call with Sarah",
  });
  expect(calls[1]!.method).toBe("POST");
  expect(JSON.parse(calls[1]!.body)).toEqual({
    file: "https://example.com/call.mp4",
    name: "Call with Sarah",
  });
});

test("reads run unasked; importing a recording asks first", () => {
  const a = otter.actions;
  for (const n of [
    "list_conversations",
    "get_conversation",
    "get_conversation_audio",
    "list_channels",
    "list_channel_members",
    "get_workspace",
    "get_workspace_analytics",
    "list_workspace_conversations",
  ])
    expect(a[n]!.readOnly).toBe(true);
  expect(a.import_recording!.readOnly).toBe(false);
});

test("Otter's error detail reaches the person", async () => {
  stub(() =>
    json(
      {
        errors: [
          {
            status: "Forbidden",
            code: "403",
            detail: "User has no permission",
          },
        ],
      },
      403,
    ),
  );
  const e = (await run("get_workspace_analytics", { id: "42" }).catch((x) => x)) as AppsError;
  expect(e.message).toContain("User has no permission");
  expect(e.expired).toBe(false);
});

test("conversation_completed: only recent conversations whose summary work is done", async () => {
  stub(() =>
    json({
      meta: { has_more: false },
      data: [
        {
          id: "done",
          created_at: ago(30),
          process_status: {
            abstract_summary: "finished",
            action_item: "finished",
            outline: null,
          },
        },
        {
          id: "busy",
          created_at: ago(5),
          process_status: {
            abstract_summary: "finished",
            action_item: null,
            outline: "processing",
          },
        },
        {
          id: "fresh",
          created_at: ago(1),
          process_status: {
            abstract_summary: null,
            action_item: null,
            outline: null,
          },
        },
        {
          id: "old",
          created_at: ago(3000),
          process_status: { abstract_summary: "finished" },
        },
      ],
    }),
  );
  const items = await polls.conversation_completed!.poll({}, pollRun);
  expect(items.map((i) => i.id)).toEqual(["done"]);
});

test("conversation_shared pages through the channel with the cursor", async () => {
  const calls = stub((c) =>
    c.url.includes("cursor=p2")
      ? json({ meta: { has_more: false }, data: [{ id: "b" }] })
      : json({
          meta: { has_more: true, next_cursor: "p2" },
          data: [{ id: "a" }],
        }),
  );
  const items = await polls.conversation_shared!.poll({ channel_id: "ch1" }, pollRun);
  expect(items.map((i) => i.id)).toEqual(["a", "b"]);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.url).toContain("channel_id=ch1");
});

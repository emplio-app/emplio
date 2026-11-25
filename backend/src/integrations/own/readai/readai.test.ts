import { afterEach, expect, test } from "bun:test";
import { AppsError } from "../../types";
import { meetingsIn, readai as polls } from "../../polls/readai";
import { readai } from "./index";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("it signs in through Read AI's MCP server, with no key", () => {
  expect(readai.app).toBe("readai");
  expect(readai.keyField).toBeUndefined();
  expect(readai.oauth?.ready()).toBe(true);
  expect(readai.mcp).toBeDefined();
});

test("the connection is labelled with the signed-in account's email, and a refused sign-in asks to reconnect", async () => {
  let asked: { url: string; auth: string } | undefined;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    asked = { url: String(url), auth: (init.headers as Record<string, string>).Authorization! };
    return new Response(JSON.stringify({ sub: "u1", email: "sarah@northwind.com" }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  expect(await readai.check("tok")).toBe("sarah@northwind.com");
  expect(asked).toEqual({ url: "https://authn.read.ai/userinfo", auth: "Bearer tok" });
  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
  const e = await readai.check("old").catch((x) => x);
  expect(e).toBeInstanceOf(AppsError);
  expect(e.expired).toBe(true);
  globalThis.fetch = (async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;
  expect(await readai.check("tok")).toBeUndefined();
});

test("meetings are read from the tool's answer however it's wrapped", () => {
  const m = { id: "01H", title: "Sync" };
  expect(meetingsIn(JSON.stringify({ object: "list", data: [m] }))).toEqual([m]);
  expect(meetingsIn(JSON.stringify({ meetings: [m] }))).toEqual([m]);
  expect(meetingsIn(JSON.stringify([m, { title: "no id" }]))).toEqual([m]);
  expect(meetingsIn("Here are your meetings: ...")).toEqual([]);
});

test("a meeting counts once it has ended recently and its summary is written, without its transcript", async () => {
  const now = Date.now();
  const list = [
    { id: "live", start_time_ms: now - 600_000, end_time_ms: null },
    { id: "done", end_time_ms: now - 60_000, summary: "We agreed on Friday", transcript: { turns: [] } },
    { id: "pending", end_time_ms: now - 60_000, summary: null },
    { id: "old", end_time_ms: now - 3 * 86_400_000, summary: "x" },
    { id: "plain", end_time_ms: now - 60_000 },
  ];
  let asked: unknown;
  const items = await polls.meeting_ended!.poll({}, async (action, input) => ((asked = [action, input]), JSON.stringify({ data: list })));
  expect(asked).toEqual(["readai.list_meetings", {}]);
  expect(items.map((i) => i.id)).toEqual(["done", "plain"]);
  expect(items[0]!.item).toEqual({ meeting: { id: "done", end_time_ms: list[1]!.end_time_ms, summary: "We agreed on Friday" } });
});

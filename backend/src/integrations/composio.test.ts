import { expect, test } from "bun:test";
import { AppsError } from "./types";
import { fetchInPages } from "./composio";

// A fake Gmail: 7 emails, one of them (e5) too big to come whole; more than 2 whole emails at once is "too large".
const fake = () => {
  const all = ["e1", "e2", "e3", "e4", "e5", "e6", "e7"];
  const asked: Record<string, unknown>[] = [];
  const execute = async (a: Record<string, any>) => {
    asked.push(a);
    const from = Number(a.page_token ?? 0);
    const ids = all.slice(from, from + a.max_results);
    const whole = a.include_payload !== false;
    if (whole && (ids.length > 2 || ids.includes("e5"))) throw new AppsError("The tool response payload is too large. Please reduce the amount of data requested.");
    const next = from + ids.length;
    return { messages: ids.map((id) => ({ id, body: whole })), ...(next < all.length && { nextPageToken: String(next) }) };
  };
  return { execute, asked };
};

test("a Gmail fetch too big for Composio comes back whole, page by page, in order", async () => {
  const { execute } = fake();
  const out = await fetchInPages(execute, { query: "x", max_results: 6 });
  expect(out.messages.map((m: any) => m.id)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
  // e5 alone was too big: it came without its body, and the answer says so
  expect(out.messages.find((m: any) => m.id === "e5")?.body).toBe(false);
  expect(out.note).toContain("1 email(s)");
  // there's more after what was asked for: the token to carry on
  expect(out.nextPageToken).toBe("6");
});

test("fewer emails than asked for: stops at the last page", async () => {
  const { execute } = fake();
  const out = await fetchInPages(execute, { max_results: 50 });
  expect(out.messages).toHaveLength(7);
  expect(out.nextPageToken).toBeUndefined();
});

test("any other error isn't retried", async () => {
  const execute = async () => {
    throw new AppsError("not connected");
  };
  await expect(fetchInPages(execute, { max_results: 10 })).rejects.toThrow("not connected");
});

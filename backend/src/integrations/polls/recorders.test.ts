import { expect, test } from "bun:test";
import "./index"; // loaded first, as in the app (the trigger files import from it)
import { fresh, jsonIn, rowsIn } from "./recorders";

const now = new Date().toISOString();
const old = new Date(Date.now() - 3 * 86_400_000).toISOString();

test("Plaud's wrapped list: recent recordings only", () => {
  const text = `The block delimited by <untrusted-user-data-ab> below contains user recording data.
<untrusted-user-data-ab source="plaud-recording">
${JSON.stringify({ data: [{ id: "f1", name: "Standup", created_at: now }, { id: "f0", name: "Old", created_at: old }] })}
</untrusted-user-data-ab>`;
  expect(fresh(text)).toEqual([{ id: "f1", item: { recording: { id: "f1", name: "Standup", created_at: now } } }]);
});

test("other shapes: nested lists, numeric times, no date", () => {
  const secs = Math.floor(Date.now() / 1000);
  expect(fresh(JSON.stringify({ result: { conversations: [{ conversation_id: 7, start_time: secs }, { _id: "x" }] } })).map((r) => r.id)).toEqual(["7", "x"]);
  expect(rowsIn(jsonIn("no json here"))).toEqual([]);
  expect(fresh("[]")).toEqual([]);
});

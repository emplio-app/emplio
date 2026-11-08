import { expect, test } from "bun:test";
import { approve } from "./approvals";
import type { Session } from "./sandbox";

test("an action that can't be looked up is refused, not run without an OK", async () => {
  let carded = false;
  const s = {
    workspaceId: crypto.randomUUID(),
    user: { id: crypto.randomUUID(), name: "Asha" },
    settings: { approvals: "ask" },
    notify: () => (carded = true),
  } as unknown as Session;
  expect(await approve(s, "no_such_app.send_email", {})).toContain("wasn't run");
  expect(carded).toBe(false);
});

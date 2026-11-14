import { expect, spyOn, test } from "bun:test";
import * as agents from "./agents";
import { describeMentions, searchMentions } from "./mentions";

// two agents, one archived; nothing else in this business
spyOn(agents, "listAgents").mockResolvedValue([
  { slug: "supplier-finder", name: "Supplier Finder", description: "", skills: [], level: "light", archived: false, instructions: "" },
  { slug: "old-helper", name: "Old Helper", description: "", skills: [], level: "light", archived: true, instructions: "" },
]);
const who = { workspaceId: crypto.randomUUID(), userId: crypto.randomUUID(), role: "owner" as const };

test("@ finds the business's agents, not archived ones, and tells Emplio to hand the work to the one picked", async () => {
  const found = (await searchMentions(who, "supp")).filter((m) => m.kind === "agent");
  expect(found).toEqual([{ kind: "agent", id: "supplier-finder", label: "Supplier Finder", detail: "Agent" }]);
  expect((await searchMentions(who, "old")).some((m) => m.kind === "agent")).toBe(false);
  expect(await describeMentions(who, [{ kind: "agent", id: "supplier-finder" }])).toContain("emplio hand supplier-finder");
  // one it doesn't have is dropped, never trusted
  expect(await describeMentions(who, [{ kind: "agent", id: "made-up" }])).toBeNull();
}, 30_000); // the other sources (files, tables) each give up on a business that has none

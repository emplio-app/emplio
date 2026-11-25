import { describe, expect, test } from "bun:test";
import { parseThing } from "./things";

describe("parseThing", () => {
  test("reads key: value lines, links on them and in the words", () => {
    const t = parseThing(
      "projects/northwind-website.md",
      "---\nclient: [[clients/northwind]]\nteam: [[team/sarah]], [[team/tom]]\nFee: 18000\n---\n# Northwind website\nAsk [[contacts/emma]] first.\n",
    )!;
    expect(t.path).toBe("projects/northwind-website");
    expect(t.kind).toBe("projects");
    expect(t.title).toBe("Northwind website");
    expect(t.fields.fee).toBe("18000");
    expect(t.links).toEqual([
      { field: "client", to: "clients/northwind" },
      { field: "team", to: "team/sarah" },
      { field: "team", to: "team/tom" },
      { field: "text", to: "contacts/emma" },
    ]);
    expect(t.error).toBeNull();
  });

  test("a contact or project without its client says so; a name: wins, else the file name", () => {
    expect(parseThing("contacts/emma-stone.md", "Likes email.")).toMatchObject({ title: "Emma Stone", error: "needs client: [[...]]" });
    expect(parseThing("team/sarah.md", "---\nname: Sarah Lee\n---\n")!.title).toBe("Sarah Lee");
  });

  test("other files aren't things", () => {
    expect(parseThing("knowledge/topics/pricing.md", "x")).toBeNull();
    expect(parseThing("projects/site/index.md", "x")).toBeNull();
    expect(parseThing("processes/onboarding.md", "x")).toBeNull();
  });
});

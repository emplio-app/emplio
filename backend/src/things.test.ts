import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { tasks, workspaces } from "./db/schema";
import { checkThings, parseThing, thingProblems } from "./things";

const read = (file: string, text: string) => parseThing(file, text)!;

describe("parseThing", () => {
  test("reads the YAML top, quoted links on it (one or a list) and links in the words", () => {
    const t = read(
      "projects/northwind-website/index.md",
      '---\nclient: "[[clients/northwind]]"\nteam:\n  - "[[team/sarah]]"\n  - "[[team/tom]]"\nFee: 18000\ndue: 2026-12-15\n---\n# Northwind website\nAsk [[contacts/emma]] first; see [[clients/northwind/decisions]].\n',
    );
    expect(t.path).toBe("projects/northwind-website");
    expect(t.kind).toBe("projects");
    expect(t.title).toBe("Northwind website");
    expect(t.fields).toMatchObject({ fee: "18000", due: "2026-12-15", team: "[[team/sarah]], [[team/tom]]" });
    expect(t.links).toEqual([
      { field: "client", to: "clients/northwind" },
      { field: "team", to: "team/sarah" },
      { field: "team", to: "team/tom" },
      { field: "text", to: "contacts/emma" },
      { field: "text", to: "clients/northwind/decisions" },
    ]);
    expect(t.problems).toEqual([]);
  });

  test("no client: is fine; a name: wins, else the folder's name", () => {
    expect(read("contacts/emma-stone/index.md", "Likes email.")).toMatchObject({ title: "Emma Stone", problems: [] });
    expect(read("team/sarah/index.md", "---\nname: Sarah Lee\n---\n").title).toBe("Sarah Lee");
  });

  test("an unquoted link is read as the link, with where to put the quotes", () => {
    const t = read("contacts/emma/index.md", "---\nname: Emma\nclient: [[clients/northwind]]\nteam:\n  - [[team/sarah]]\n---\n");
    expect(t.links).toEqual([
      { field: "client", to: "clients/northwind" },
      { field: "team", to: "team/sarah" },
    ]);
    expect(t.problems).toEqual([
      { line: 3, text: 'put links in quotes: "[[clients/northwind]]"' },
      { line: 5, text: 'put links in quotes: "[[team/sarah]]"' },
    ]);
  });

  test("a YAML syntax error says its line; the words are still there", () => {
    const t = read("clients/acme/index.md", '---\nname: Acme\nstage: "active\n---\nNotes.\n');
    expect(t.problems.length).toBeGreaterThan(0);
    expect(t.problems[0]!.line).toBe(3);
    expect(t.body).toBe("Notes.");
    expect(t.title).toBe("Acme");
  });

  test("a nested object and wrong built-in fields are problems; the rest is read", () => {
    const t = read("clients/acme/index.md", "---\nname: Acme\nstage: won\naddress:\n  city: Seattle\nfee: 18,000 + VAT\n---\n");
    expect(t.fields.name).toBe("Acme");
    expect(t.problems).toEqual([
      { line: 4, text: "address has fields inside it; keep it flat: one value or a list" },
      { line: 3, text: "stage is one of prospect, active, past" },
    ]);
  });

  test("other files aren't things", () => {
    expect(parseThing("knowledge/topics/pricing.md", "x")).toBeNull();
    expect(parseThing("projects/site.md", "x")).toBeNull();
    expect(parseThing("clients/acme/decisions.md", "x")).toBeNull();
    expect(parseThing("processes/onboarding/index.md", "x")).toBeNull();
  });
});

describe("checkThings", () => {
  test("one type per field name in a kind; a single link where others have a list is fine; a missing thing warns", () => {
    const all = checkThings([
      read("projects/a/index.md", '---\nstart: 2026-01-05\nteam:\n  - "[[team/x]]"\n---\n'),
      read("projects/b/index.md", '---\nstart: 2026-02-01\nteam: "[[team/x]]"\n---\n'),
      read("projects/c/index.md", "---\nstart: soon\n---\n"),
      read("team/x/index.md", "---\nstart: soon\n---\n"),
    ]);
    expect(all[0]!.problems).toEqual([]);
    expect(all[1]!.problems).toEqual([]);
    expect(all[2]!.problems).toEqual([
      { line: 2, text: "start is a date: YYYY-MM-DD" },
      { line: 2, text: "start is a text here but a date in other projects files; use one type" },
    ]);
    expect(all[3]!.problems).toEqual([{ line: 2, text: "start is a date: YYYY-MM-DD" }]);
  });

  test("a link to a thing that isn't there is a warning", () => {
    const [t] = checkThings([read("contacts/emma/index.md", '---\nclient: "[[clients/nobody]]"\n---\n')]);
    expect(t!.problems).toEqual([{ line: 2, text: "[[clients/nobody]] links to nothing yet", warning: true }]);
  });
});

test("a client's folder removed while open tasks point at it: Emplio is told what to do", async () => {
  const [ws] = await db.insert(workspaces).values({ name: `things-test-${crypto.randomUUID().slice(0, 8)}` }).returning();
  try {
    await db.insert(tasks).values([
      { workspaceId: ws!.id, title: "a", client: "acme" },
      { workspaceId: ws!.id, title: "b", client: "acme", status: "done" },
    ]);
    const said = await thingProblems(ws!.id, [{ path: "clients/acme/index.md", text: null }, { path: "clients/other/index.md", text: null }]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("company/clients/acme was removed but 1 open task points at it");
    expect(said[0]).toContain("emplio clients remove acme");
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
  }
});

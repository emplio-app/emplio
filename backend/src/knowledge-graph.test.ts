import { expect, test } from "bun:test";
import { linkGraph } from "./knowledge";

test("links join notes, records and a record's own folder; unwritten notes and records stay as ids", () => {
  const g = linkGraph([
    { repo: "company", path: "clients/northwind/index.md", title: "Northwind", links: ["projects/site"] },
    { repo: "company", path: "clients/northwind/decisions.md", title: null, links: [] },
    { repo: "company", path: "meetings/kickoff.md", title: "Kickoff", links: ["clients/northwind", "knowledge/pricing", "knowledge/missing"] },
    { repo: "company", path: "knowledge/pricing.md", title: null, links: [] },
    { repo: "restricted", path: "clients/acme/index.md", title: null, links: [] },
    { repo: "me-u1", path: "todo.md", title: null, links: ["clients/acme", "ideas/x"] },
    { repo: "company", path: ".hidden/x.md", title: null, links: ["clients/northwind"] },
  ]);
  // a record's own page is the record's dot; other notes are repo/path
  expect(g.nodes.map((n) => n.id).sort()).toEqual(["clients/acme", "clients/northwind", "company/clients/northwind/decisions.md", "company/knowledge/pricing.md", "company/meetings/kickoff.md", "me-u1/todo.md"]);
  const has = (a: string, b: string) => g.edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  expect(has("clients/northwind", "projects/site")).toBe(true);
  expect(has("company/clients/northwind/decisions.md", "clients/northwind")).toBe(true);
  expect(has("company/meetings/kickoff.md", "clients/northwind")).toBe(true);
  expect(has("company/meetings/kickoff.md", "company/knowledge/pricing.md")).toBe(true);
  expect(has("company/meetings/kickoff.md", "company/knowledge/missing.md")).toBe(true);
  expect(has("me-u1/todo.md", "clients/acme")).toBe(true);
  expect(has("me-u1/todo.md", "me-u1/ideas/x.md")).toBe(true);
  expect(g.edges.length).toBe(7);
});

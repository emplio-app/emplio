import { expect, test } from "bun:test";
import { db } from "./db";
import { contacts, projects } from "./db/schema";
import { allClientsPrivate, visibleProject } from "./records";

// Bare "id" inside "from clients c" meant c.id, so every linked contact read as private; bare "client_id" inside
// "from client_handlers h" meant h.client_id, so a handler of any client saw every private project
test("privacy checks name the outer table's columns in full", () => {
  const contact = db.select({ w: allClientsPrivate() }).from(contacts).toSQL().sql;
  expect(contact).toContain('l.contact_id = "contacts"."id"');
  expect(contact).not.toMatch(/= "id"/);
  const project = db.select({ id: projects.id }).from(projects).where(visibleProject({ workspaceId: "w", role: "member", userId: "u" })).toSQL().sql;
  expect(project).toContain('h.client_id = "projects"."client_id"');
});

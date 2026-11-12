import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { users, workspaces } from "./db/schema";
import { settingsCommand } from "./settings";

test("emplio settings: every change waits for Allow; a no changes nothing; keys and staff are refused", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const [ws] = await db.insert(workspaces).values({ name: "Asha Rao's workspace" }).returning();
  const [user] = await db.insert(users).values({ email: `settings-test-${tag}@example.com`, name: "Asha Rao" }).returning();
  const owner = { workspaceId: ws!.id, userId: user!.id, role: "owner" };
  const member = { ...owner, role: "member" };
  const asked: string[] = [];
  let answer: string | null = "error: Asha said no";
  const allow = async (title: string) => (asked.push(title), answer);
  const business = async () => (await db.query.workspaces.findFirst({ where: eq(workspaces.id, ws!.id) }))!;
  try {
    expect(await settingsCommand(owner, [], allow)).toContain("name: Asha Rao's workspace");

    // a no: nothing changes, whatever it was
    expect(await settingsCommand(owner, ["set", "name", '"Lumen Coffee"'], allow)).toBe("error: Asha said no");
    expect(await settingsCommand(owner, ["set", "briefHour", "8"], allow)).toBe("error: Asha said no");
    expect((await business()).name).toBe("Asha Rao's workspace");
    expect((await business()).settings).toEqual({});

    answer = null;
    expect(await settingsCommand(owner, ["set", "name", '"Lumen Coffee"'], allow)).toContain("Lumen Coffee");
    expect(await settingsCommand(owner, ["set", "modelSet", "best"], allow)).toContain("Quality is now best");
    expect((await business()).name).toBe("Lumen Coffee");
    expect((await business()).settings).toEqual({ modelSet: "best" });
    expect(asked).toEqual(["Rename the business to Lumen Coffee", "Change Morning brief to 8", "Rename the business to Lumen Coffee", "Change Quality to best"]);

    // staff: their own name only
    expect(await settingsCommand(member, ["set", "my-name", "Asha R."], allow)).toContain("Asha R.");
    expect((await db.query.users.findFirst({ where: eq(users.id, user!.id) }))!.name).toBe("Asha R.");
    expect(await settingsCommand(member, ["set", "briefHour", "7"], allow)).toContain("only the owner or an admin");

    asked.length = 0;
    expect(await settingsCommand(owner, ["set", "maxSteps", "9999"], allow)).toContain("error");
    expect(await settingsCommand(owner, ["set", "openrouterKey", "sk-or-x"], allow)).toContain("never in a chat");
    expect(asked).toEqual([]);
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
    await db.delete(users).where(eq(users.id, user!.id));
  }
});

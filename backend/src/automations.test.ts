import { createHmac } from "node:crypto";
import { expect, test } from "bun:test";
import { automationsCommand, NOT_DONE, outcome, parseAutomation, periodOf, signatureOk } from "./automations";

test("parses an automation file", () => {
  const a = parseAutomation(`---\nwhen: trigger\ntrigger: gmail.new_gmail_message\nconfig:\n  query: "from:@acme.com"\n---\nAdd the lead.\n`);
  expect(a).toMatchObject({ when: "trigger", trigger: "gmail.new_gmail_message", triggerConfig: { query: "from:@acme.com" }, enabled: true, prompt: "Add the lead." });
  expect(parseAutomation(`---\nwhen: schedule\nschedule: "0 9 * * 1-5"\n---\nSales.`)).toMatchObject({ schedule: "0 9 * * 1-5", timezone: "Asia/Kolkata" });
  expect(parseAutomation(`---\nwhen: schedule\nschedule: "nope"\n---\nx`)).toHaveProperty("error");
  expect(parseAutomation(`---\nwhen: trigger\n---\nx`)).toHaveProperty("error");
  expect(parseAutomation(`---\nwhen: manual\n---\n`)).toHaveProperty("error");
  expect(parseAutomation(`no settings`)).toHaveProperty("error");
});

test("a schedule can be done for each client", () => {
  expect(parseAutomation(`---\nwhen: schedule\nschedule: "0 9 1 * *"\nclients: all\ndue: 5\n---\nMonthly report\n`)).toMatchObject({ clients: ["*"], dueDays: 5 });
  expect(parseAutomation(`---\nwhen: schedule\nschedule: "0 9 1 4 *"\nclients: [Northwind Traders, contoso]\n---\nAnnual filing\n`)).toMatchObject({ clients: ["Northwind Traders", "contoso"], dueDays: 7 });
  expect(parseAutomation(`---\nwhen: schedule\nschedule: "0 9 * * 1"\n---\nX\n`)).toMatchObject({ clients: null, dueDays: null });
  expect(parseAutomation(`---\nwhen: manual\nclients: all\n---\nX\n`)).toHaveProperty("error");
  expect(parseAutomation(`---\nwhen: schedule\nschedule: "0 9 1 * *"\nclients: []\n---\nX\n`)).toHaveProperty("error");
  expect(parseAutomation(`---\nwhen: schedule\nschedule: "0 9 1 * *"\nclients: all\ndue: soon\n---\nX\n`)).toHaveProperty("error");
  // one way to make work: a task for a person, a process per client or per new client
  expect(parseAutomation(`---\nwhen: schedule\nschedule: "0 9 * * 1"\nwho: Sarah\n---\nCheck the bank feed\n`)).toMatchObject({ who: "Sarah", dueDays: 1, clients: null });
  expect(parseAutomation(`---\nwhen: schedule\nschedule: "0 9 * * 1"\nwho: emplio\n---\nX\n`)).toMatchObject({ who: null, dueDays: null });
  expect(parseAutomation(`---\nwhen: new client\nprocess: onboarding\n---\nOnboard them\n`)).toMatchObject({ when: "new client", process: "onboarding", dueDays: 7 });
  expect(parseAutomation(`---\nwhen: schedule\nschedule: "0 9 1 * *"\nprocess: books\n---\nX\n`)).toHaveProperty("error");
  expect(parseAutomation(`---\nwhen: new client\nprocess: onboarding\nwho: Sarah\n---\nX\n`)).toHaveProperty("error");
  expect(parseAutomation(`---\nwhen: new client\nclients: all\n---\nX\n`)).toHaveProperty("error");
});

test("names the period a run is for", () => {
  const at = new Date("2026-11-01T04:00:00Z");
  expect(periodOf("0 9 1 * *", "Asia/Kolkata", at)).toBe("Nov 2026");
  expect(periodOf("0 9 1 4 *", "Asia/Kolkata", at)).toBe("2026");
  expect(periodOf("0 9 * * 1", "Asia/Kolkata", at)).toBe("week of 1 Nov");
  expect(periodOf("0 9 1 1,4,7,10 *", "Asia/Kolkata", at)).toBe("Q4 2026");
  expect(periodOf("0 9 * * *", "Asia/Kolkata", at)).toBe("1 Nov 2026");
});

test("checks webhook signatures", () => {
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);
  const sig = createHmac("sha256", "secret").update(`msg_1.${ts}.{"a":1}`).digest("base64");
  expect(signatureOk("secret", "msg_1", ts, `{"a":1}`, `v1,${sig}`, now)).toBe(true);
  expect(signatureOk("secret", "msg_1", ts, `{"a":2}`, `v1,${sig}`, now)).toBe(false);
  expect(signatureOk("secret", "msg_1", ts, `{"a":1}`, `v1,${sig}`, now + 600_000)).toBe(false);
});

test("an automation can name its agent", () => {
  const a = parseAutomation(`---\nwhen: schedule\nschedule: "0 9 * * 1"\nagent: "Supplier Finder"\n---\nFind new flour suppliers.\n`);
  expect(a).toMatchObject({ when: "schedule", agent: "Supplier Finder" });
  expect(parseAutomation(`---\nwhen: manual\n---\nX\n`)).toMatchObject({ agent: null });
  expect(parseAutomation(`---\nwhen: manual\nagent: [a]\n---\nX\n`)).toHaveProperty("error");
});

test("adding an automation with a name but no file says the file is missing, not the whole usage", async () => {
  const said = await automationsCommand({ workspaceId: "w", userId: "u" } as never, ["add", "daily"], async () => {});
  expect(said).toStartWith("error: daily needs its file");
});

test("a run that didn't do its work, or said nothing, shows as failed, not done (#244)", () => {
  expect(outcome(null, `${NOT_DONE} Sent 0 of 20 invites: every profile asked for an email.`)).toEqual({
    status: "failed",
    error: "Sent 0 of 20 invites: every profile asked for an email.",
    said: "failed: Sent 0 of 20 invites: every profile asked for an email.",
  });
  // its own word wins over the routine marker
  expect(outcome(null, `${NOT_DONE} Blocked again. [SILENT]`).status).toBe("failed");
  expect(outcome(null, null)).toMatchObject({ status: "failed", error: "it ended without saying what came of it" });
  expect(outcome(null, "  ")).toMatchObject({ status: "failed" });
  expect(outcome("credit ran out", null)).toEqual({ status: "failed", error: "credit ran out", said: "failed: credit ran out" });
  expect(outcome(null, "Sent 20 invites.")).toEqual({ status: "done", error: null, said: "Sent 20 invites." });
  expect(outcome(null, "No new notes this run. [SILENT]")).toEqual({ status: "done", error: null, said: null });
  // it reported a problem and still said nothing to do: failed, so the person hears and the check-in fixes it
  expect(outcome(null, "[SILENT]", "signups_since needs a run argument")).toEqual({
    status: "failed",
    error: "it hit a problem and still reported nothing to do: signups_since needs a run argument",
    said: "failed: it hit a problem and still reported nothing to do: signups_since needs a run argument",
  });
  // one it reported and then told the person about stays done: they hear it either way
  expect(outcome(null, "Sent 3 of 4; the fourth bounced.", "a send failed").status).toBe("done");
});

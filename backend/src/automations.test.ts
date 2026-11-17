import { createHmac } from "node:crypto";
import { expect, test } from "bun:test";
import { automationsCommand, parseAutomation, signatureOk } from "./automations";

test("parses an automation file", () => {
  const a = parseAutomation(`---\nwhen: trigger\ntrigger: gmail.new_gmail_message\nconfig:\n  query: "from:@acme.com"\n---\nAdd the lead.\n`);
  expect(a).toMatchObject({ when: "trigger", trigger: "gmail.new_gmail_message", triggerConfig: { query: "from:@acme.com" }, enabled: true, prompt: "Add the lead." });
  expect(parseAutomation(`---\nwhen: schedule\nschedule: "0 9 * * 1-5"\n---\nSales.`)).toMatchObject({ schedule: "0 9 * * 1-5", timezone: "Asia/Kolkata" });
  expect(parseAutomation(`---\nwhen: schedule\nschedule: "nope"\n---\nx`)).toHaveProperty("error");
  expect(parseAutomation(`---\nwhen: trigger\n---\nx`)).toHaveProperty("error");
  expect(parseAutomation(`---\nwhen: manual\n---\n`)).toHaveProperty("error");
  expect(parseAutomation(`no settings`)).toHaveProperty("error");
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

import { expect, test } from "bun:test";
import { joinKey, keyReady } from "@emplio/shared";
import { APPS } from "./own";

const field = (app: string) => Object.values(APPS).find((a) => a.app === app)!.keyField!;

test("separate boxes join into the one key each app reads", () => {
  expect(joinKey(field("harvest"), ["1234567", " tok "])).toBe("1234567:tok");
  expect(joinKey(field("zendesk"), ["acme", "sarah@northwind.com", "tok"])).toBe("acme sarah@northwind.com tok");
  expect(joinKey(field("wrike"), ["", "tok"])).toBe("tok");
  expect(joinKey(field("wrike"), ["eu", "tok"])).toBe("eu:tok");
  expect(joinKey(field("godaddy"), ["", "KEY", "SECRET"])).toBe("KEY:SECRET");
  expect(joinKey(field("godaddy"), ["gd_pat", "KEY", "SECRET"])).toBe("gd_pat KEY:SECRET");
  expect(joinKey(field("cashfree"), ["id", "secret", "sandbox"])).toBe("id:secret:sandbox");
  expect(joinKey(field("calcom"), ["", "cal_live_x"])).toBe("cal_live_x");
});

test("a key is ready once every part that isn't optional is filled in", () => {
  expect(keyReady(field("gohighlevel"), ["pit-x", ""])).toBe(true);
  expect(keyReady(field("zendesk"), ["acme", "", "tok"])).toBe(false);
});

test("every app with boxes has a label for each, and choices only on optional parts", () => {
  for (const a of Object.values(APPS))
    for (const p of a.keyField?.parts ?? []) {
      expect(p.label).toBeTruthy();
      if (p.options) expect(p.optional).toBe(true);
    }
});

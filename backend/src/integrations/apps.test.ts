import { expect, test } from "bun:test";
import { CATALOG } from "./catalog";
import { availableApps } from "./index";
import { own } from "./own";

// sign-in only: not connectable until this server has their client id and secret
const SIGN_IN_ONLY = ["slack", "zoom", "googlecalendar", "googledocs", "googlesheets", "googlemeet", "zoho_mail", "zoho_books", "zoho_invoice", "zoho"];
const NEEDS = ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET"];

test("with no Composio account, every app with a pasted key is still offered, and no Composio app is", async () => {
  delete process.env.COMPOSIO_API_KEY;
  for (const name of NEEDS) delete process.env[name];
  const offered = (await availableApps()).map((a) => a.app).sort();
  expect(offered).toEqual(CATALOG.filter((a) => a.provider === "own" && !SIGN_IN_ONLY.includes(a.app)).map((a) => a.app).sort());
  expect(offered).toContain("razorpay");
  expect(offered).not.toContain("gmail");
});

test("a sign-in-only app is offered once its client id and secret are set", async () => {
  for (const name of NEEDS) process.env[name] = "x";
  try {
    const ready = await own.readyApps();
    expect(SIGN_IN_ONLY.filter((a) => !ready.has(a))).toEqual([]);
  } finally {
    for (const name of NEEDS) delete process.env[name];
  }
});

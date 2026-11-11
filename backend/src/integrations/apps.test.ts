import { expect, test } from "bun:test";
import { CATALOG } from "./catalog";
import { availableApps, providerFor } from "./index";
import { own } from "./own";

// sign-in only: not connectable until this server has their client id and secret
const SIGN_IN_ONLY = ["slack", "zoom", "googlebusiness", "googlecalendar", "googledocs", "googlesheets", "googlemeet", "googlesearchconsole", "googleanalytics", "zoho_mail", "zoho_books", "zoho_invoice", "zoho"];
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

test("an app held back stays on Composio, except for the workspaces testing ours", () => {
  process.env.KEEP_ON_COMPOSIO = "slack, zoom";
  process.env.OWN_APP_TESTERS = "tester";
  try {
    expect(providerFor("slack").name).toBe("composio");
    expect(providerFor("slack", { workspaceId: "customer" }).name).toBe("composio");
    expect(providerFor("slack", { workspaceId: "tester" }).name).toBe("own");
    expect(providerFor("zoho_mail", { workspaceId: "customer" }).name).toBe("own");
  } finally {
    delete process.env.KEEP_ON_COMPOSIO;
    delete process.env.OWN_APP_TESTERS;
  }
  expect(providerFor("slack", { workspaceId: "customer" }).name).toBe("own");
});

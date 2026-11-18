import { expect, test } from "bun:test";
import { CATALOG } from "./catalog";
import { afterCheck, availableApps, MISSING_SCOPE, providerFor } from "./index";
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

test("a sign-in given up on never shows as expired: a reconnect gets its old login back, a new account goes", () => {
  const reconnecting = { status: "pending" as const, label: "me@work.com", oldExternalId: "ca_old" };
  const adding = { status: "pending" as const, label: null, oldExternalId: null };
  expect(afterCheck(reconnecting, "expired")).toBe("restore");
  expect(afterCheck(reconnecting, "failed")).toBe("restore");
  expect(afterCheck(reconnecting, "pending")).toBe("store");
  expect(afterCheck(reconnecting, "active")).toBe("finish");
  expect(afterCheck(adding, "expired")).toBe("drop");
  expect(afterCheck(adding, "active")).toBe("store");
  // left over from before: never signed in, already stored as expired
  expect(afterCheck({ status: "expired", label: null, oldExternalId: null }, "expired")).toBe("drop");
  // a reconnect of an account that had already stopped working: expired is the truth
  expect(afterCheck({ status: "pending", label: "me@work.com", oldExternalId: null }, "expired")).toBe("store");
});

test("permissions left out at sign-in are told apart from a file the account can't open", () => {
  // what Google Drive said, through Composio, to an account signed in with its box unticked
  expect(MISSING_SCOPE.test('Error finding files: 403. { "error": { "code": 403, "message": "Request had insufficient authentication scopes."')).toBe(true);
  expect(MISSING_SCOPE.test("ACCESS_TOKEN_SCOPE_INSUFFICIENT")).toBe(true);
  expect(MISSING_SCOPE.test('"reason": "insufficientFilePermissions", "message": "The user does not have sufficient permissions for this file."')).toBe(false);
});

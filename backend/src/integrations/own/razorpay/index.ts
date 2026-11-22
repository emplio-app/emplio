// Razorpay on the business's own API keys: orders, payments, refunds, settlements, customers, invoices, payment
// links, subscriptions, QR codes, virtual accounts, Route, disputes, webhooks and partner accounts. This is the
// business taking its customers' money; Emplio's own billing is the unrelated src/razorpay.ts.
// Razorpay has no OpenAPI spec. actions.json was converted once from the official SDK's endpoint list and is now
// edited by hand. COVERAGE.md says what's left out.
import { AppsError } from "../../types";
import type { OwnApp } from "../index";
import { type Api, call, specActions } from "../openapi";
import { events, triggers, watch } from "./webhooks";

const api: Api = {
  name: "Razorpay",
  base: "https://api.razorpay.com",
  tokenHelp: "Razorpay Dashboard → Account & Settings → API Keys",
  auth: (key) => ({ Authorization: `Basic ${Buffer.from(key).toString("base64")}` }),
};

const actions = await specActions(new URL("./actions.json", import.meta.url), api);
// Razorpay only reads the literal query name expand[]; the input calls it expand
for (const a of Object.values(actions)) {
  const run = a.run;
  a.run = (i, key) => run({ ...i, "expand[]": i.expand }, key);
}

export const razorpay: OwnApp = {
  app: "razorpay",
  name: "Razorpay",
  logo: "/logos/razorpay.svg",
  keyField: {
    label: "Key ID and Key Secret",
    help: "Razorpay Dashboard → Account & Settings → API Keys → generate a key.",
    placeholder: "rzp_live_XXXXXXXXXXXXXX:your-key-secret",
    sep: ":",
    parts: [{label:"Key ID",placeholder:"rzp_live_XXXXXXXXXXXXXX"},{label:"Key Secret",secret:true,placeholder:"your-key-secret"}],
  },
  // Razorpay has no "who am I"; this is its cheapest call that needs a working key
  async check(key) {
    const [id, secret] = key.split(":");
    if (!id || !secret) throw new AppsError("enter both the Key ID and the Key Secret");
    await call(api, key, { method: "GET", path: "/v1/payments", query: ["count"], headers: [] }, { count: 1 });
  },
  actions,
  push: { events, triggers, start: (key, connection, event) => watch(api, key, connection, event) },
};

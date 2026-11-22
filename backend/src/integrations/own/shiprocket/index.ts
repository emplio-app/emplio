// Shiprocket on the owner's API user: every call in Shiprocket's API collection (apidocs.shiprocket.in) — orders,
// returns and exchanges, couriers and rates, AWBs, pickups, labels, manifests, invoices, tracking, failed deliveries,
// pickup locations, products, listings, channels, inventory, wallet and international shipping. No OpenAPI spec, so
// the calls are listed by hand; COVERAGE.md says what's where. Triggers are polled (polls/shiprocket.ts).
import type { OwnApp } from "../index";
import { catalogActions } from "./catalog";
import { login } from "./client";
import { orderActions } from "./orders";
import { shippingActions } from "./shipping";

export const shiprocket: OwnApp = {
  app: "shiprocket",
  name: "Shiprocket",
  logo: "/logos/shiprocket.svg",
  keyField: {
    label: "API user email and password",
    help: "In Shiprocket go to Settings → API → Configure → Create an API user. Use a new email (not your Shiprocket login), tick all modules, and Shiprocket emails you its password.",
    placeholder: "api@yourshop.com:password",
    sep: ":",
    parts: [{label:"API user email",placeholder:"api@yourshop.com"},{label:"Password",secret:true}],
  },
  // logs in once; a wrong email or password marks the connection for reconnecting
  async check(key) {
    return (await login(key)).name || undefined;
  },
  actions: { ...orderActions, ...shippingActions, ...catalogActions },
};

// Plivo on the business's own Auth ID and Auth Token: every call of Plivo's REST API — account and
// subaccounts, SMS/MMS/WhatsApp, Powerpacks, 10DLC and toll-free registration, voice calls, conferences,
// multi-party calls, recordings, numbers, lookup, Verify, compliance, number masking, PHLO and SIP trunking.
// Plivo has no OpenAPI spec, so the calls are listed by hand; COVERAGE.md says what's where.
import { AppsError } from "../../types";
import type { OwnApp } from "../index";
import { call } from "../openapi";
import { accountActions } from "./account";
import { api } from "./client";
import { messagingActions } from "./messaging";
import { numberActions } from "./numbers";
import { voiceActions } from "./voice";
import { zentrunkActions } from "./zentrunk";

export const plivo: OwnApp = {
  app: "plivo",
  name: "Plivo",
  logo: "/logos/plivo.svg",
  keyField: {
    label: "Auth ID and Auth Token",
    help: "console.plivo.com → Overview shows your Auth ID and Auth Token.",
    placeholder: "MAXXXXXXXXXXXXXXXXXX:your-auth-token",
    sep: ":",
    parts: [{label:"Auth ID",placeholder:"MAXXXXXXXXXXXXXXXXXX"},{label:"Auth Token",secret:true,placeholder:"your-auth-token"}],
  },
  // the account's own details; wrong credentials get a 401, which marks the connection for reconnecting
  async check(key) {
    const [id, token] = key.split(":");
    if (!id || !token) throw new AppsError("enter both the Auth ID and the Auth Token");
    await call(api, key, { method: "GET", path: "/", query: [], headers: [] }, {});
  },
  actions: { ...accountActions, ...messagingActions, ...voiceActions, ...numberActions, ...zentrunkActions },
};

// Talking to Freshdesk (API v2). One key, "yourco.freshdesk.com:API_KEY", sent as HTTP Basic auth (API_KEY:X) to
// that helpdesk's own address. Only *.freshdesk.com hosts are allowed, so a key can never be sent anywhere else.
import { z } from "zod";
import { AppFile, AppsError } from "../../types";
import type { OwnAction } from "../index";
import { type Api, call, rest } from "../openapi";

const FORMAT = "paste your helpdesk address and API key joined by a colon, like yourco.freshdesk.com:YOUR_API_KEY";

// the helpdesk host and API key in a connection's key; throws when it isn't a *.freshdesk.com address
export function login(key: string) {
  const at = key.lastIndexOf(":");
  if (at < 0) throw new AppsError(FORMAT);
  let host = key.slice(0, at).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const token = key.slice(at + 1).trim();
  if (host && !host.includes(".")) host += ".freshdesk.com";
  if (!token || !/^[a-z0-9][a-z0-9-]*\.freshdesk\.com$/.test(host)) throw new AppsError(`${FORMAT} (only yourco.freshdesk.com addresses work)`);
  return { host, token };
}

export const api: Api = {
  name: "Freshdesk",
  base: "",
  tokenHelp: "Freshdesk → your profile picture → Profile settings → View API key, pasted as yourco.freshdesk.com:API_KEY",
  auth: (key) => ({ Authorization: `Basic ${Buffer.from(`${login(key).token}:X`).toString("base64")}` }),
  url: (key, _base, path) => `https://${login(key).host}/api/v2${path}`,
};

type Opts = { readOnly?: boolean; query?: string[]; loose?: boolean };

// A Freshdesk call: {names} in the path come from the input; the rest is the query (GET/DELETE) or the JSON body.
// `loose` lets the rarer fields Freshdesk takes through untouched.
export const r = (method: string, path: string, description: string, shape: z.ZodRawShape = {}, opts: Opts = {}): OwnAction =>
  rest(api, method, path, description, opts.loose ? z.object(shape).loose() : z.object(shape), opts);

const inPath = (path: string) => [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
const hasFile = (v: unknown): boolean =>
  v instanceof AppFile || (Array.isArray(v) ? v.some(hasFile) : !!v && typeof v === "object" && Object.values(v).some(hasFile));

// Like r, but when a file is given ({"file": "/work/..."}) the call goes as multipart, the way Freshdesk takes
// attachments: arrays as name[], objects as name[key] (cc_emails[], custom_fields[cf_x]).
export const withFiles = (method: string, path: string, description: string, shape: z.ZodRawShape, opts: Opts = {}): OwnAction => {
  const json = r(method, path, description, shape, { loose: true, ...opts });
  const parts = inPath(path);
  return {
    ...json,
    run: (i: Record<string, unknown>, key: string) => {
      if (!hasFile(i)) return json.run(i, key);
      const flat: Record<string, unknown> = Object.fromEntries(parts.map((k) => [k, i[k]]));
      const fields: [string, string][] = [];
      const add = (name: string, v: unknown): void => {
        if (v === undefined) return;
        if (Array.isArray(v)) return v.forEach((x) => add(`${name}[]`, x));
        if (v && typeof v === "object" && !(v instanceof AppFile)) return Object.entries(v).forEach(([k, x]) => add(`${name}[${k}]`, x));
        const f = `_${fields.length}`;
        flat[f] = v ?? "";
        fields.push([f, name]);
      };
      for (const [k, v] of Object.entries(i)) if (!parts.includes(k)) add(k, v);
      return call(api, key, { method, path, query: [], headers: [], body: { kind: "form", fields } }, flat);
    },
  };
};

// A call whose body Freshdesk wants inside one key ({"bulk_action": {...}}); the input stays flat for the agent.
export const wrapped = (method: string, path: string, description: string, into: string, shape: z.ZodRawShape): OwnAction => {
  const parts = inPath(path);
  return {
    description,
    input: z.object(shape),
    readOnly: false,
    run: (i: Record<string, unknown>, key: string) => {
      const inner = Object.fromEntries(Object.entries(i).filter(([k, v]) => !parts.includes(k) && v !== undefined));
      return call(api, key, { method, path, query: [], headers: [], body: { kind: "whole", field: "_body" } }, { ...i, _body: { [into]: inner } });
    },
  };
};

// ── shared fields
export const id = (what: string, from?: string) => z.number().int().describe(`The ${what}'s id${from ? ` (${from})` : ""}`);
export const page = {
  page: z.number().int().min(1).optional().describe("Page number, from 1 (default 1). An empty list means there are no more pages."),
  per_page: z.number().int().min(1).max(100).optional().describe("How many per page, up to 100 (default 30)"),
};
export const files = z.array(z.any()).optional().describe('Files to attach, each as {"file": "/work/..."} (20 MB in total at most)');
export const customFields = z.record(z.string(), z.any()).optional().describe('Custom field values by their name, e.g. {"cf_order_number": "A-1001"} (freshdesk.list_ticket_fields / get_contact_fields / get_company_fields give the names)');
export const tags = z.array(z.string()).optional().describe("Tags. On an update this replaces every tag the record has.");
export const emails = (what: string) => z.array(z.string()).optional().describe(what);
export const STATUS = "Status: 2 Open, 3 Pending, 4 Resolved, 5 Closed (higher numbers are your own custom statuses)";
export const PRIORITY = "Priority: 1 Low, 2 Medium, 3 High, 4 Urgent";
export const SOURCE = "Where it came from: 1 Email, 2 Portal, 3 Phone, 7 Chat, 9 Feedback widget, 10 Outbound email";

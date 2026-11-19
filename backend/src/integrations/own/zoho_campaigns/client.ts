// Talking to Zoho Campaigns (API v1.1). Every call takes its fields in the query string, the way all of Zoho's samples
// send them, plus resfmt=JSON (or type=json on the few older calls). Values that are JSON (contactinfo, details...)
// are sent as JSON text. The host follows the login's data centre: campaigns.zoho.in, campaigns.zohocloud.ca...
import { z } from "zod";
import { AppsError } from "../../types";
import type { OwnAction } from "../index";
import { type Api, call } from "../openapi";
import { zohoClient, zohoFailed, zohoMail } from "../zoho-login";

// ponytail: Campaigns sits next to Mail in every data centre, so it is worked out from Mail's address instead of a table entry
export const campaignsHost = (key: string) => zohoMail(key).replace("://mail.", "://campaigns.");

// "Nothing here yet" comes back as a failure; an empty account isn't an error. 2401 no lists, 6101 no campaigns, 992 no tags, 2604 empty segment.
const EMPTY = new Set(["2401", "6101", "992", "2604"]);
const failed = (body: any) => {
  if (EMPTY.has(String(body?.code))) return;
  const why = zohoFailed("Zoho Campaigns", body);
  if (why) return why;
  // its codes come as text, "0" or "200" when it worked
  if (body?.code !== undefined && !["0", "200"].includes(String(body.code)) && body.status !== "success") return body.message ?? `error ${body.code}`;
  const inner = body?.response;
  if (inner?.code !== undefined && !["0", "200"].includes(String(inner.code))) return inner.message ?? `error ${inner.code}`;
};

export const api: Api = { ...zohoClient("Zoho Campaigns", "https://campaigns.zoho.com"), url: (key, _base, path) => `${campaignsHost(key)}/api/v1.1${path}`, failed };

// Some answers come back as JSON with a text content type; read them as JSON and check them the same way.
const parsed = (out: unknown) => {
  if (typeof out !== "string") return out;
  let body: unknown;
  try {
    body = JSON.parse(out);
  } catch {
    return out;
  }
  const why = failed(body);
  if (why) throw new AppsError(`Zoho Campaigns: ${why}`);
  return body;
};

type Opts = {
  // only looks things up: runs without asking
  read?: boolean;
  // the older calls name the format `type` (json) instead of resfmt (JSON)
  fmt?: "type";
  // turns the input into what Zoho takes (JSON fields, fixed values)
  build?: (i: Record<string, any>) => Record<string, unknown>;
};

// One Zoho Campaigns call: {names} in the path come from the input, everything else goes in the query.
export const op = (method: string, path: string, description: string, shape: z.ZodRawShape, opts: Opts = {}): OwnAction => ({
  description,
  input: z.object(shape),
  readOnly: Boolean(opts.read),
  run: async (i: Record<string, any>, key: string) => {
    const all: Record<string, unknown> = { ...(opts.build ? opts.build(i) : i), ...(opts.fmt === "type" ? { type: "json" } : { resfmt: "JSON" }) };
    const query = Object.keys(all).filter((k) => all[k] !== undefined && !path.includes(`{${k}}`));
    return parsed(await call(api, key, { method, path, query, csv: query, headers: [] }, all));
  },
});

// shared fields
export const listkey = z.string().min(1).describe("The mailing list's listkey (from zoho_campaigns.list_mailing_lists)");
export const campaignkey = z.string().min(1).describe("The campaign's campaign_key (from zoho_campaigns.list_recent_campaigns)");
export const email = (what: string) => z.string().min(1).describe(what);
export const fromindex = z.number().int().min(1).optional().describe("Where to start, counting from 1 (default 1); add range to get the next page");
export const range = z.number().int().min(1).max(200).optional().describe("How many to return (default 20)");
export const sort = z.enum(["asc", "desc"]).optional().describe("Order: asc (oldest first) or desc (newest first)");
export const fieldtype = z
  .enum(["Text", "Integer", "Phone", "Date", "Picklist", "Email", "Checkbox", "LongInteger", "URL", "textarea", "RadioOption", "Multiselect", "DateTime", "Decimal", "Percent"])
  .describe("What kind of value the field holds");

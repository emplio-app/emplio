// Talking to Bing Webmaster Tools. One pasted API key, sent as ?apikey= on every call — Bing's JSON service
// takes no auth header at all. Three quirks it has, handled here once:
//  - every answer is wrapped in {"d": ...}, so `tidy` unwraps it
//  - dates are written the .NET way, /Date(1762819200000+0000)/, both ways
//  - a bad key is ErrorCode 3 answered with a 400 (not a 401), and some failures come back with a 200
import { z } from "zod";
import { AppsError } from "../../types";
import type { OwnAction } from "../index";
import { type Api, call, rest } from "../openapi";

export const api: Api = {
  name: "Bing Webmaster Tools",
  base: "https://ssl.bing.com/webmaster/api.svc/json",
  tokenHelp: "bing.com/webmasters → the gear (Settings) → API access → API key",
  // the key travels in the query string; there is no header to put it in
  auth: () => ({}),
  // a withdrawn or mistyped key is ErrorCode 3, and Bing answers it with a 400 rather than a 401
  deadToken: (status, body) => status === 401 || body?.ErrorCode === 3,
  // Bing answers some failures with a 200 and the trouble in the body
  failed: (body) => (body?.ErrorCode ? `${body.Message ?? "it refused the request"} (code ${body.ErrorCode})` : undefined),
};

// /Date(1762819200000)/ or /Date(1762819200000+0000)/ — how Bing writes every date
const DOTNET_DATE = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/;
const plain = (v: unknown): unknown => {
  if (typeof v === "string") {
    const m = DOTNET_DATE.exec(v);
    return m ? new Date(Number(m[1])).toISOString() : v;
  }
  if (Array.isArray(v)) return v.map(plain);
  // __type is the .NET class name on every object: noise for the reader
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "__type").map(([k, x]) => [k, plain(x)]));
  return v;
};
// unwrap {"d": ...}, turn Bing's dates into ordinary ones, and drop the .NET type tags
export const tidy = (out: unknown) => plain(out && typeof out === "object" && "d" in (out as Record<string, unknown>) ? (out as Record<string, unknown>).d : out);

// A date on its way to Bing, in the shape its service insists on
export const bingDate = (v?: string) => {
  const ms = v ? Date.parse(v) : Date.now();
  if (Number.isNaN(ms)) throw new AppsError(`date: "${v}" isn't a date; write it as 2026-11-11 or 2026-11-11T09:00:00Z`);
  return `/Date(${ms}+0000)/`;
};

// One Bing call. A GET takes its fields in the query, a POST takes them as a JSON body; the key goes in the
// query either way, so `apikey` rides along on every call.
export const r = (method: "GET" | "POST", op: string, description: string, shape: z.ZodRawShape = {}, opts: { readOnly?: boolean } = {}): OwnAction => {
  const action = rest(api, method, `/${op}`, description, z.object(shape), { readOnly: opts.readOnly ?? method === "GET", query: ["apikey"] });
  return { ...action, run: (i: Record<string, unknown>, key: string) => action.run({ ...i, apikey: key }, key).then(tidy) };
};

// A POST whose body Bing wants as a nested object: its .NET types need a __type tag and /Date(…)/ fields,
// so the flat input the AI gives is folded into that shape here.
export const shaped = (op: string, description: string, shape: z.ZodRawShape, body: (i: any) => Record<string, unknown>, opts: { readOnly?: boolean } = {}): OwnAction => ({
  description,
  readOnly: opts.readOnly ?? false,
  input: z.object(shape),
  run: (i: Record<string, unknown>, key: string) =>
    call(api, key, { method: "POST", path: `/${op}`, query: ["apikey"], headers: [], body: { kind: "whole", field: "body" } }, { apikey: key, body: body(i) }).then(tidy),
});

// the .NET class tag Bing checks on an object in a request body
export const tag = (type: string) => ({ __type: `${type}:#Microsoft.Bing.Webmaster.Api` });

// ── fields used across the groups
export const siteUrl = z
  .string()
  .min(1)
  .describe("Your website, written exactly as Bing Webmaster Tools lists it, e.g. https://example.com (bing_webmaster.get_user_sites shows them)");
export const pageOf = (what: string) => z.number().int().min(0).optional().describe(`Which page of ${what} to read, counting from 0 (default 0)`);
export const url = (what: string) => z.string().min(1).describe(what);
export const dateField = (what: string) =>
  z.string().optional().describe(`${what}, e.g. 2026-11-11 (Bing ignores it on most calls; left out, today is used)`);
export const country = z
  .string()
  .min(2)
  .describe("Which country's Bing results, as a two-letter code in lower case, e.g. gb, us, in");
export const language = z.string().min(2).describe('Language and country of the Bing results, e.g. "en-GB", "en-US", "en-IN"');
export const day = (what: string) => z.string().min(8).describe(`${what}, written as 2026-11-11`);

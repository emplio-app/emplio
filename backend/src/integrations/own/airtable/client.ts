// Talking to Airtable: a personal access token as a Bearer header, everything under api.airtable.com/v0.
import { z } from "zod";
import type { OwnAction } from "../index";
import { type Api, call, rest } from "../openapi";

export const api: Api = { name: "Airtable", base: "https://api.airtable.com", tokenHelp: "airtable.com/create/tokens" };

type Opts = { readOnly?: boolean; loose?: boolean; base?: string };
// {names} in the path come from the input; the rest is the query (GET/DELETE) or the JSON body
export const r = (method: string, path: string, description: string, shape: z.ZodRawShape = {}, opts: Opts = {}): OwnAction => {
  const input = opts.loose ? z.object(shape).loose() : z.object(shape);
  return rest(opts.base ? { ...api, base: opts.base } : api, method, path, description, input, opts);
};

// A call with a list that goes in the query, as name[]=a&name[]=b (the way Airtable reads lists; `rest` repeats the bare name)
export const withList = (method: string, path: string, description: string, shape: z.ZodRawShape, list: string, readOnly: boolean): OwnAction => ({
  description,
  input: z.object(shape),
  readOnly,
  run: (i: Record<string, unknown>, key: string) => call(api, key, { method, path, query: [`${list}[]`], headers: [] }, { ...i, [`${list}[]`]: i[list] }),
});

export const baseId = z.string().min(1).describe("The base's id, starting app... (airtable.list_bases, or the base's web address)");
export const table = z.string().min(1).describe("The table's id (tbl...) or name; the id keeps working if someone renames the table (airtable.get_base_schema)");
export const recordId = z.string().min(1).describe("The record's id, starting rec... (airtable.list_records)");
export const fields = z.record(z.string(), z.any()).describe('The cell values by field name, e.g. {"Name": "Asha", "Status": "Open"}');
export const typecast = z.boolean().optional().describe("true lets Airtable convert text into the right kind of cell (and add new select options). Default false");
export const byFieldId = z.boolean().optional().describe("true answers with field ids instead of field names. Default false");
export const include = (values: readonly [string, ...string[]]) => z.array(z.enum(values)).optional().describe(`Extra details to include: ${values.join(", ")}`);

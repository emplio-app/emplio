// Apps built from the provider's OpenAPI spec: scripts/openapi-actions.ts turns the spec into actions.json
// (one action per operation, with how to send it), and this runs them. Vercel, Hostinger, OpenRouter, Exa and
// Sarvam are made this way; Plivo, MSG91 and LiveKit (no spec) list their calls by hand and run them here too.
import { z } from "zod";
import { AppFile, AppsError } from "../types";
import type { OwnAction } from "./index";

export type Api = {
  name: string;
  base: string;
  // where a new token comes from, for the reconnect message
  tokenHelp: string;
  // how the key is sent (default: Authorization: Bearer <key>)
  auth?: (key: string, input: Record<string, any>) => Record<string, string>;
  // the base and path when they hold part of the key (Plivo's /Account/{auth_id}/)
  url?: (key: string, base: string, path: string) => string;
  // whether the token is dead (default: a 401), for providers that say so otherwise
  deadToken?: (status: number, body: any) => boolean;
  // a failure the provider answers with a 200 (MSG91's {"type": "error"}): why, or nothing when it worked
  failed?: (body: any) => string | undefined;
  // extra headers an upload needs (a checksum…)
  upload?: (file: AppFile, send: Send, headers: Record<string, string>) => void;
};

// logs stream for as long as the deployment runs; a call reads this long, or this many lines, then hands back what came
const STREAM_MS = 10_000;
const STREAM_LINES = 1000;

export type Send = {
  method: string;
  // when not the app's base (another of its servers)
  base?: string;
  path: string;
  query: string[];
  // array query params sent comma separated instead of repeating the key
  csv?: string[];
  headers: [field: string, header: string][];
  body?: { kind: "fields" | "form" | "urlencoded"; fields: [field: string, key: string][] } | { kind: "whole" | "file"; field: string };
};
type Generated = { name: string; group: string; description: string; readOnly: boolean; input: object; send: Send };

const queryValue = (v: unknown) => (Array.isArray(v) ? v.join(",") : typeof v === "object" ? JSON.stringify(v) : String(v));

// a form body with nested values as a[b][0]=c, the way Stripe reads them; an empty object or array clears the field
function formPairs(key: string, v: unknown): [string, string][] {
  if (v === undefined) return [];
  if (v === null) return [[key, ""]];
  if (Array.isArray(v)) return v.length ? v.flatMap((x, i) => formPairs(`${key}[${i}]`, x)) : [[key, ""]];
  if (typeof v === "object") return Object.keys(v).length ? Object.entries(v).flatMap(([k, x]) => formPairs(`${key}[${k}]`, x)) : [[key, ""]];
  return [[key, String(v)]];
}

const parseLine = (line: string) => {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
};

// an answer that keeps coming (application/stream+json, x-ndjson): the lines that came within the limits
async function readStream(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const lines: unknown[] = [];
  let rest = "";
  const stop = setTimeout(() => reader.cancel().catch(() => {}), STREAM_MS);
  try {
    while (lines.length < STREAM_LINES) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      rest += decoder.decode(value, { stream: true });
      const parts = rest.split("\n");
      rest = parts.pop()!;
      for (const p of parts) if (p.trim()) lines.push(parseLine(p));
    }
  } finally {
    clearTimeout(stop);
    reader.cancel().catch(() => {});
  }
  return { lines: lines.slice(0, STREAM_LINES), more: lines.length >= STREAM_LINES ? "stopped at 1000 lines; ask with since/until for more" : undefined };
}

export async function call(api: Api, key: string, send: Send, input: Record<string, any>) {
  const path = send.path.replace(/\{(\w+)\}/g, (_, k) => {
    if (input[k] === undefined || input[k] === "") throw new AppsError(`${k} is required`);
    return encodeURIComponent(String(input[k]));
  });
  const q = new URLSearchParams();
  for (const k of send.query) {
    const v = input[k];
    if (v === undefined) continue;
    if (Array.isArray(v) && !send.csv?.includes(k)) for (const x of v) q.append(k, queryValue(x));
    else q.append(k, queryValue(v));
  }
  const headers: Record<string, string> = api.auth?.(key, input) ?? { Authorization: `Bearer ${key}` };
  for (const [field, header] of send.headers) if (input[field] !== undefined) headers[header] = String(input[field]);
  let body: BodyInit | undefined;
  if (send.body?.kind === "fields") {
    body = JSON.stringify(Object.fromEntries(send.body.fields.flatMap(([f, k]) => (input[f] === undefined ? [] : [[k, input[f]]]))));
  } else if (send.body?.kind === "urlencoded") {
    body = new URLSearchParams(send.body.fields.flatMap(([f, k]) => formPairs(k, input[f]))).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (send.body?.kind === "form") {
    // multipart: files as files, objects as JSON, the rest as text; fetch sets the boundary
    const form = new FormData();
    const part = (k: string, v: unknown) =>
      v instanceof AppFile ? form.append(k, new Blob([v.bytes as Uint8Array<ArrayBuffer>], { type: v.mimetype }), v.name) : form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    for (const [f, k] of send.body.fields) {
      const v = input[f];
      if (v === undefined) continue;
      if (Array.isArray(v) && v.some((x) => x instanceof AppFile)) for (const x of v) part(k, x);
      else part(k, v);
    }
    body = form;
  } else if (send.body?.kind === "whole" && input[send.body.field] !== undefined) body = JSON.stringify(input[send.body.field]);
  else if (send.body?.kind === "file") {
    const file = input[send.body.field];
    if (!(file instanceof AppFile)) throw new AppsError('file: give the file as {"file": "/work/..."}');
    body = file.bytes as Uint8Array<ArrayBuffer>;
    headers["Content-Type"] = "application/octet-stream";
    api.upload?.(file, send, headers);
  }
  if (body !== undefined && !(body instanceof FormData) && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  const base = send.base ?? api.base;
  const url = api.url ? api.url(key, base, path) : `${base}${path}`;
  const res = await fetch(`${url}${q.size ? `?${q}` : ""}`, { method: send.method, headers, body });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    const text = await res.text();
    const j = parseLine(text);
    // Twirp (LiveKit) says {"code", "msg"}; Plivo {"error": "..."}; Razorpay {"error": {"description"}}
    const why = j?.error?.message ?? j?.error?.description ?? j?.message ?? j?.Message ?? j?.msg ?? (typeof j?.error === "string" ? j.error : undefined) ?? text;
    // field-by-field validation errors, as Laravel-style APIs give them: {"errors": {"name": ["is taken"]}}
    const fields = j?.errors && typeof j.errors === "object" && !Array.isArray(j.errors)
      ? Object.entries(j.errors).map(([k, v]) => `${k}: ${[v].flat().join(", ")}`).join("; ")
      : "";
    if (api.deadToken ? api.deadToken(res.status, j) : res.status === 401)
      throw new AppsError(`${api.name} rejected the token; make a new one (${api.tokenHelp}) and reconnect`, true);
    throw new AppsError(`${api.name}: ${why || res.statusText}${fields ? ` (${fields})` : ""} (${res.status})`);
  }
  if (/stream\+json|ndjson/.test(type)) return readStream(res);
  if (type.includes("json")) {
    const text = await res.text();
    const out = text ? JSON.parse(text) : { ok: true };
    const why = api.failed?.(out);
    if (why) throw new AppsError(`${api.name}: ${why}`);
    return out;
  }
  if (type.startsWith("text/") || res.status === 204) return (await res.text()) || { ok: true };
  // files (artifacts, deployment files, registry blobs) come back as a file in the chat's computer
  const bytes = new Uint8Array(await res.arrayBuffer());
  return new AppFile(path.split("/").pop() || "download", type.split(";")[0] || "application/octet-stream", bytes);
}

// the actions in a generated actions.json, run against `api`
export async function specActions(file: URL, api: Api): Promise<Record<string, OwnAction>> {
  const { actions } = (await Bun.file(file).json()) as { actions: Generated[] };
  return Object.fromEntries(
    actions.map((a) => [
      a.name,
      {
        description: a.description,
        readOnly: a.readOnly,
        input: z.fromJSONSchema(a.input as z.core.JSONSchema.JSONSchema) as z.ZodObject,
        run: (i: Record<string, unknown>, key: string) => call(api, key, a.send, i),
      },
    ]),
  );
}

// A call written by hand, for a provider with no spec: the {names} in the path come from the input, the rest
// goes in the query for a GET or DELETE and in the JSON body otherwise (including fields a .loose() input
// lets through, so nothing the API takes is out of reach). `query` sends those fields in the query anyway.
export function rest(
  api: Api,
  method: string,
  path: string,
  description: string,
  input: z.ZodObject,
  opts: { readOnly?: boolean; query?: string[] } = {},
): OwnAction {
  const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
  const bodyless = method === "GET" || method === "DELETE";
  return {
    description,
    input,
    readOnly: opts.readOnly ?? method === "GET",
    run: (i: Record<string, unknown>, key: string) => {
      const rest = Object.keys(i).filter((k) => !inPath.includes(k) && i[k] !== undefined);
      const query = bodyless ? rest : rest.filter((k) => opts.query?.includes(k));
      const fields = bodyless ? [] : rest.filter((k) => !query.includes(k)).map((k): [string, string] => [k, k]);
      return call(api, key, { method, path, query, headers: [], body: fields.length ? { kind: "fields", fields } : undefined }, i);
    },
  };
}

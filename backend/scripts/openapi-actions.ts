// Builds an own app's actions.json from the provider's OpenAPI spec: one action per API operation, its input
// a flat JSON schema (path, query and header params, and the body's fields), plus how to send it; own/openapi.ts
// runs them. What the spec can't say (names, which calls are secret…) is in scripts/openapi/<app>.ts.
// Run again when the provider's API grows:  bun scripts/openapi-actions.ts <app> [spec.json|yaml ...]
// (default: downloads the app's spec(s); JSON or YAML)

type Schema = Record<string, any>;
export type AppConfig = {
  // several specs make one app (Exa's search and websets); an operation of any but the first, or with its own
  // servers, is sent to that server instead of the app's base
  spec: string | string[];
  // the server for a path, when the spec lists several and doesn't say which serves what
  server?: (path: string, spec: number) => string | undefined;
  out: string;
  // the action's name from the snake_cased operation id (and the call, when ids repeat), before `rename`
  name?: (id: string, method: string, path: string, op: Schema) => string;
  rename?: Record<string, string>;
  // non-GETs that only look things up, so they run without asking
  reads?: string[];
  // GETs that hand back a secret (a value, a token, a transfer code), so they ask first
  secrets?: string[];
  // operations left out on purpose (by operation id, or "METHOD /path" when ids repeat), and why: for COVERAGE.md
  skip?: Record<string, string> | ((method: string, path: string) => string | undefined);
  // params taken out of an action ("*": out of every action)
  drop?: Record<string, string[]>;
  // better descriptions for params the spec describes poorly, by name
  params?: Record<string, string>;
};

const app = process.argv[2];
if (!app) throw new Error("usage: bun scripts/openapi-actions.ts <app> [spec.json|yaml ...]");
const config: AppConfig = (await import(`./openapi/${app}.ts`)).default;
const READS = new Set(config.reads);
const SECRETS = new Set(config.secrets);
const DROP = config.drop ?? {};
const RENAME = config.rename ?? {};
const sources = process.argv.length > 3 ? process.argv.slice(3) : [config.spec].flat();
const load = async (src: string): Promise<Schema> => {
  const text = /^https?:/.test(src) ? await (await fetch(src)).text() : await Bun.file(src).text();
  return text.trimStart().startsWith("{") ? JSON.parse(text) : Bun.YAML.parse(text);
};
// the spec being read; resolve() looks refs up in it
let spec: Schema = {};

const resolve = (s: Schema): Schema => {
  if (!s?.$ref) return s;
  const path = (s.$ref as string).replace(/^#\//, "").split("/");
  return resolve(path.reduce((o: Schema, k) => o[k], spec));
};

const MAX_DEPTH = 6;
const KEEP = ["type", "description", "enum", "default", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"];

// The spec's schema, cut down to what an agent needs and zod can rebuild: refs inlined, allOf merged,
// oneOf/anyOf as anyOf, nullable as a null type, formats and patterns dropped, deep nesting left open.
function clean(raw: Schema, depth = 0, seen = new Set<string>()): Schema {
  if (raw?.$ref) {
    if (seen.has(raw.$ref) || depth > MAX_DEPTH) return { description: raw.description ?? "an object (see the provider's API docs)" };
    return clean(resolve(raw), depth, new Set([...seen, raw.$ref]));
  }
  if (!raw || typeof raw !== "object") return {};
  if (depth > MAX_DEPTH) return raw.description ? { description: raw.description } : {};
  if (raw.allOf) {
    const parts = raw.allOf.map((p: Schema) => clean(p, depth, seen));
    const merged: Schema = { type: "object", properties: {}, required: [] };
    for (const p of parts) {
      Object.assign(merged.properties, p.properties ?? {});
      merged.required.push(...(p.required ?? []));
      if (p.description && !merged.description) merged.description = p.description;
    }
    if (raw.description) merged.description = raw.description;
    if (!merged.required.length) delete merged.required;
    return Object.keys(merged.properties).length ? merged : (parts[0] ?? {});
  }
  const out: Schema = {};
  for (const k of KEEP) if (raw[k] !== undefined) out[k] = raw[k];
  if (Array.isArray(out.type)) out.type = out.type.filter((t: string) => t !== "null");
  if (Array.isArray(out.type) && out.type.length === 1) out.type = out.type[0];
  if (Array.isArray(out.type) && !out.type.length) delete out.type;
  if (out.enum) out.enum = out.enum.filter((v: unknown) => v !== null);
  if (out.enum && !out.enum.length) delete out.enum;
  const alts = raw.oneOf ?? raw.anyOf;
  if (alts) {
    const options = alts.map((a: Schema) => clean(a, depth + 1, seen)).filter((a: Schema) => Object.keys(a).length);
    if (options.length === 1) Object.assign(out, options[0], raw.description ? { description: raw.description } : {});
    else if (options.length) out.anyOf = options;
  }
  if (raw.properties) {
    out.type = "object";
    out.properties = Object.fromEntries(Object.entries(raw.properties).map(([k, v]) => [k, clean(v as Schema, depth + 1, seen)]));
    if (raw.required?.length) out.required = raw.required.filter((r: string) => r in out.properties);
  }
  if (raw.items) out.items = clean(raw.items, depth + 1, seen);
  if (raw.additionalProperties && typeof raw.additionalProperties === "object") out.additionalProperties = clean(raw.additionalProperties, depth + 1, seen);
  if (out.type === "object" && !out.properties && !out.additionalProperties) out.additionalProperties = {};
  return out;
}

const snake = (id: string) =>
  id
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[-\s.]+/g, "_")
    .toLowerCase();

const describe = (o: Schema) => {
  const summary = (o.summary ?? "").trim().replace(/\.?$/, ".");
  const more = (o.description ?? "").trim();
  const text = more && !more.toLowerCase().startsWith(summary.toLowerCase().slice(0, -1)) ? `${summary} ${more}` : more || summary;
  return text.length > 700 ? `${text.slice(0, 697)}...` : text;
};

const actions: Schema[] = [];
const skipped: string[] = [];

// a multipart field that is a file (or files): the agent gives {"file": "/work/..."}
const isFile = (raw: Schema): boolean => {
  const s = resolve(raw ?? {});
  return s.format === "binary" || Boolean(s.contentMediaType) || (s.type === "array" && isFile(s.items));
};
const FILE = 'A file from the computer: {"file": "/work/..."}';

for (const [index, src] of sources.entries()) {
spec = await load(src);
for (const [path, ops] of Object.entries<Schema>(spec.paths)) {
  for (const [method, op] of Object.entries<Schema>(ops)) {
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    const call = `${method.toUpperCase()} ${path}`;
    const why = typeof config.skip === "function" ? config.skip(method.toUpperCase(), path) : (config.skip?.[op.operationId] ?? config.skip?.[call]);
    if (why) {
      skipped.push(`${call} (${op.operationId}): ${why}`);
      continue;
    }
    if (op.deprecated) {
      skipped.push(`${method.toUpperCase()} ${path} (${op.operationId}): deprecated`);
      continue;
    }
    const id = (config.name ?? ((x: string) => x))(snake(op.operationId), method.toUpperCase(), path, op);
    const name = RENAME[id] ?? id;
    const properties: Schema = {};
    const required: string[] = [];
    const send: Schema = { method: method.toUpperCase(), path, query: [], headers: [] };
    const server: string | undefined = config.server?.(path, index) ?? (op.servers ?? ops.servers ?? (index > 0 ? spec.servers : undefined))?.[0]?.url;
    if (server) send.base = server.replace(/\/$/, "");
    // the path's own params, then the operation's (which win)
    const params = [...(ops.parameters ?? []), ...(op.parameters ?? [])].map(resolve);
    for (const p of params.filter((p, i) => !params.slice(i + 1).some((q) => q.name === p.name && q.in === p.in))) {
      if (p.name === "Content-Length") continue; // fetch sets it
      if (DROP[name]?.includes(p.name) || DROP["*"]?.includes(p.name)) continue;
      const s = clean(p.schema ?? {});
      const field = p.in === "header" ? snake(p.name) : p.name;
      properties[field] = { ...s, description: config.params?.[p.name] ?? p.description ?? s.description };
      if (p.required || p.in === "path") required.push(field);
      if (p.in === "query") send.query.push(field);
      // an array in the query repeats its key (OpenAPI's default), unless the spec says explode: false
      if (p.in === "query" && s.type === "array" && p.explode === false) (send.csv ??= []).push(field);
      if (p.in === "header") send.headers.push([field, p.name]);
    }
    const content = op.requestBody?.content ?? {};
    if (content["application/octet-stream"]) {
      properties.file = { description: 'The file to upload: {"file": "/work/..."}' };
      required.push("file");
      send.body = { kind: "file", field: "file" };
    } else if (content["application/json"]) {
      const body = clean(content["application/json"].schema ?? {});
      if (body.type === "object" && body.properties) {
        const fields: [string, string][] = [];
        for (const [k, v] of Object.entries<Schema>(body.properties)) {
          const field = k in properties ? `body_${k}` : k;
          properties[field] = v;
          fields.push([field, k]);
          if (op.requestBody.required !== false && body.required?.includes(k)) required.push(field);
        }
        send.body = { kind: "fields", fields };
      } else {
        properties.body = { ...body, description: body.description ?? "The request body" };
        if (op.requestBody.required) required.push("body");
        send.body = { kind: "whole", field: "body" };
      }
    } else if (content["multipart/form-data"]) {
      const body = resolve(content["multipart/form-data"].schema ?? {});
      const fields: [string, string][] = [];
      for (const [k, v] of Object.entries<Schema>(body.properties ?? {})) {
        const field = k in properties ? `body_${k}` : k;
        const desc = resolve(v).description;
        properties[field] = !isFile(v)
          ? clean(v)
          : resolve(v).type === "array"
            ? { type: "array", items: {}, description: `${desc ? `${desc} ` : ""}One or more files: [{"file": "/work/..."}]` }
            : { description: `${desc ? `${desc} ` : ""}${FILE}` };
        fields.push([field, k]);
        if (op.requestBody.required !== false && body.required?.includes(k)) required.push(field);
      }
      send.body = { kind: "form", fields };
    } else if (Object.keys(content).length) {
      skipped.push(`${method.toUpperCase()} ${path} (${op.operationId}): body type ${Object.keys(content).join(", ")} not supported`);
      continue;
    }
    actions.push({
      name,
      group: op.tags?.[0] ?? "other",
      description: SECRETS.has(name) ? `${describe(op)} Shows a secret: only when the person needs it, never pasted in a chat.` : describe(op),
      readOnly: (method === "get" && !SECRETS.has(name)) || READS.has(name),
      input: { type: "object", properties, ...(required.length && { required: [...new Set(required)] }) },
      send,
    });
  }
}
}

const names = new Set<string>();
for (const a of actions) {
  if (names.has(a.name)) throw new Error(`two operations make the action ${a.name}`);
  names.add(a.name);
}
// an override for an operation the provider renamed or dropped would otherwise go quietly unused
for (const n of [...Object.values(RENAME), ...READS, ...SECRETS, ...Object.keys(DROP).filter((n) => n !== "*")])
  if (!names.has(n)) throw new Error(`override for ${n}, which is no longer an operation`);
const out = new URL(`../${config.out}`, import.meta.url).pathname;
await Bun.write(out, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), skipped, actions }));
console.log(`${actions.length} actions, ${skipped.length} skipped → ${out}`);

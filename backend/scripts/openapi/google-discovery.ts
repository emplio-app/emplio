// Google publishes Discovery documents, not OpenAPI. This turns one into an OpenAPI file for ../openapi-actions.ts to read.
// Every method becomes an operation; a method none of the app's scopes covers stops the build, so nothing ships that can't run.
import { tmpdir } from "node:os";
import { join } from "node:path";

type Schema = Record<string, any>;

// output-only fields can't be sent, so they stay out of the input
const writable = (props: Schema = {}) => Object.fromEntries(Object.entries(props).filter(([, p]) => !p.readOnly && !/^Output only\b/i.test(p.description ?? "")));

function convert(s: Schema): Schema {
  if (s.$ref) return { $ref: `#/components/schemas/${s.$ref}`, ...(s.description && { description: s.description }) };
  const out: Schema = {};
  if (s.description) out.description = s.description;
  // "any" isn't a JSON Schema type; integers that overflow come as strings, as Google sends them
  if (s.type && s.type !== "any") out.type = s.type;
  if (s.enum) out.enum = s.enum;
  if (s.properties) out.properties = Object.fromEntries(Object.entries(writable(s.properties)).map(([k, p]) => [k, convert(p as Schema)]));
  if (s.items) out.items = convert(s.items);
  if (s.additionalProperties) out.additionalProperties = convert(s.additionalProperties);
  return out;
}

const param = (name: string, location: string, p: Schema) => ({
  name,
  in: location,
  required: Boolean(p.required) || location === "path",
  description: p.description,
  schema: p.repeated ? { type: "array", items: convert({ ...p, description: undefined, repeated: undefined }) } : convert({ ...p, description: undefined }),
});

export async function discovery(url: string, app: string, scopes: string[]) {
  const doc = (await (await fetch(url)).json()) as Schema;
  // Google Business Profile's documents name no scopes at all (every one of its APIs sits behind business.manage alone),
  // so there is nothing to check against; a document that does name them still has every method checked.
  const declaresScopes = Boolean(doc.auth?.oauth2?.scopes);
  const schemas = Object.fromEntries(Object.entries<Schema>(doc.schemas).map(([k, s]) => [k, convert(s)]));
  const paths: Schema = {};
  const method = (m: Schema) => {
    if (declaresScopes && !m.scopes?.some((s: string) => scopes.includes(s))) throw new Error(`${m.id} needs one of ${m.scopes}, and ${app} asks for none of them`);
    const path = `/${m.flatPath ?? m.path}`;
    const named = [...path.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!);
    const declared = Object.entries<Schema>(m.parameters ?? {});
    const parameters = [
      ...declared.filter(([n, p]) => p.location !== "path" || named.includes(n)).map(([n, p]) => param(n, p.location, p)),
      // a flat path's pieces of a resource name ({spacesId} for spaces/*)
      ...named.filter((n) => !declared.some(([d]) => d === n)).map((n) => {
        const before = path.split(`{${n}}`)[0]!.split("/").at(-2);
        return param(n, "path", { type: "string", description: `The id after "${before}/" in the resource's name` });
      }),
      ...(m.httpMethod === "GET" ? [param("fields", "query", { type: "string", description: "Only these fields in the answer, in Google's partial-response syntax, e.g. items(id,summary),nextPageToken. Leave out for everything" })] : []),
    ];
    const op: Schema = { operationId: m.id.split(".").slice(1).join("."), description: m.description, parameters };
    if (m.deprecated) op.deprecated = true;
    if (m.request) {
      const body = doc.schemas[m.request.$ref] as Schema;
      const required = Object.entries<Schema>(body.properties ?? {}).filter(([, p]) => p.annotations?.required?.includes(m.id)).map(([k]) => k);
      const schema = { type: "object", properties: convert(body).properties ?? {}, ...(required.length && { required }) };
      op.requestBody = { required: Object.keys(schema.properties).length > 0, content: { "application/json": { schema } } };
    }
    (paths[path] ??= {})[m.httpMethod.toLowerCase()] = op;
  };
  const walk = (r: Schema) => {
    Object.values<Schema>(r.methods ?? {}).forEach(method);
    Object.values<Schema>(r.resources ?? {}).forEach(walk);
  };
  walk(doc);
  const out = join(tmpdir(), `${app}-openapi.json`);
  await Bun.write(out, JSON.stringify({ openapi: "3.0.0", info: { title: doc.title, version: doc.version }, paths, components: { schemas } }));
  return out;
}

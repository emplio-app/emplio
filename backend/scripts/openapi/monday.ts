// monday.com's API is GraphQL only, so its actions come from the schema rather than an OpenAPI spec. This reads the
// published schema (api.monday.com/v2/get_schema, no key needed) and writes src/integrations/own/monday/actions.json:
// every query and mutation, with its arguments and the fields asked for back by default.
// Run from backend/:  bun scripts/openapi/monday.ts [version]
const VERSION = process.argv[2] ?? "2026-10";

// calls a personal token can't make: they answer for an app's own token only, or are a schema placeholder
const SKIP: Record<string, string> = {
  app_subscription: "answers only for an app's own token, about the account that installed it",
  app_subscription_operations: "answers only for an app's own token",
  set_mock_app_subscription: "an app's own token only (testing a paid app)",
  remove_mock_app_subscription: "an app's own token only (testing a paid app)",
  increase_app_subscription_operations: "an app's own token only",
  empty: "a placeholder in monday's schema that does nothing",
  "mutation complexity": "only means something next to another mutation in the same call; the complexity query and the graphql action cover it",
};
// calls that hand back a secret: they ask first even though they change nothing
const SECRETS = new Set(["service_user_tokens"]);
// queries that change something
const WRITES = new Set<string>([]);

// fields asked for by default, where the automatic pick would be too thin or too costly
const ITEM = "id name state url created_at updated_at creator_id board { id name } group { id title } column_values { id type text value } parent_item { id name }";
const PICK: Record<string, string> = {
  Item: ITEM,
  ItemsResponse: `cursor items { ${ITEM} }`,
  Board: "id name description state board_kind type url permissions items_count updated_at workspace_id board_folder_id top_group { id } owners { id name } subscribers { id name } columns { id title type description settings_str } groups { id title color position archived deleted } tags { id name } workspace { id name }",
  Update: "id body text_body created_at updated_at creator_id item_id creator { id name } replies { id text_body created_at creator { id name } } assets { id name public_url }",
  Reply: "id body text_body created_at updated_at creator_id creator { id name }",
  Asset: "id name url public_url file_extension file_size created_at uploaded_by { id name }",
  User: "id name email title phone location url kind status is_deleted time_zone_identifier last_activity created_at account { id name slug tier } teams { id name } department { id name }",
};

type TypeRef = { kind: string; name: string | null; ofType: TypeRef | null };
type Arg = { name: string; description: string | null; type: TypeRef; defaultValue: string | null };
type Field = { name: string; description: string | null; args: Arg[]; type: TypeRef; isDeprecated: boolean; deprecationReason: string | null };
type Type = { kind: string; name: string; description: string | null; fields: Field[] | null; inputFields: Arg[] | null; enumValues: { name: string; isDeprecated: boolean }[] | null; possibleTypes: { name: string }[] | null };

const res = await fetch(`https://api.monday.com/v2/get_schema?format=json&version=${VERSION}`);
if (!res.ok) throw new Error(`get_schema: ${res.status}`);
const schema = ((await res.json()) as { data: { __schema: { types: Type[] } } }).data.__schema;
const types = new Map(schema.types.map((t) => [t.name, t]));

const named = (t: TypeRef): TypeRef => (t.ofType ? named(t.ofType) : t);
const gql = (t: TypeRef): string => (t.kind === "NON_NULL" ? `${gql(t.ofType!)}!` : t.kind === "LIST" ? `[${gql(t.ofType!)}]` : t.name!);
const leaf = (t: TypeRef) => ["SCALAR", "ENUM"].includes(types.get(named(t).name!)!.kind);
const needsArgs = (f: Field) => f.args.some((a) => a.type.kind === "NON_NULL" && a.defaultValue === null);
const usable = (f: Field) => !f.isDeprecated && !needsArgs(f);
const leaves = (t: Type) => (t.fields ?? []).filter((f) => usable(f) && leaf(f.type)).map((f) => f.name);

// what to ask for back: the type's own values, and one level into the objects it points at. A wrapper with no values
// of its own ({results: [...]}) doesn't use up a level; a union is asked for as each of its kinds' values.
function pick(name: string, depth = 0): string {
  if (PICK[name]) return PICK[name]!;
  const t = types.get(name)!;
  if (t.kind === "UNION") {
    // a name two kinds give different types (String and String!) can't be asked for in both: GraphQL refuses the query
    const typeOf = new Map<string, Set<string>>();
    for (const p of t.possibleTypes ?? []) for (const f of types.get(p.name)!.fields ?? []) typeOf.set(f.name, (typeOf.get(f.name) ?? new Set()).add(gql(f.type)));
    const ok = (n: string) => typeOf.get(n)!.size === 1;
    const parts = (t.possibleTypes ?? []).map((p) => [p.name, leaves(types.get(p.name)!).filter(ok).join(" ")]).filter(([, s]) => s);
    return ["__typename", ...parts.map(([n, s]) => `... on ${n} { ${s} }`)].join(" ");
  }
  const own = leaves(t);
  const out: string[] = [];
  for (const f of t.fields ?? []) {
    if (!usable(f)) continue;
    const inner = named(f.type).name!;
    if (leaf(f.type)) out.push(f.name);
    else if (depth > 4) continue;
    else if (depth < 1 || !own.length || types.get(inner)!.kind === "UNION") {
      const s = pick(inner, own.length ? depth + 1 : depth);
      if (s) out.push(`${f.name} { ${s} }`);
    }
  }
  if (t.kind === "INTERFACE") out.unshift("__typename");
  return out.join(" ");
}

// a query with no arguments whose every field takes some (search, notetaker): each field is its own action
const namespace = (f: Field) => {
  const t = types.get(named(f.type).name!)!;
  return !f.args.length && t.kind === "OBJECT" && (t.fields ?? []).length > 0 && (t.fields ?? []).every((x) => x.args.length);
};

// an argument, as the agent is told about it
type Input = { name: string; gql: string; type: string; list?: number; values?: string[]; required: boolean; description: string };
function input(a: Arg): Input {
  const t = types.get(named(a.type).name!)!;
  let list = 0;
  for (let r: TypeRef | null = a.type; r; r = r.ofType) if (r.kind === "LIST") list++;
  const kind =
    t.kind === "ENUM" ? "enum" : t.kind === "INPUT_OBJECT" ? "object" : ({ Int: "int", Float: "number", Boolean: "boolean", JSON: "json", File: "file", CompareValue: "any" } as Record<string, string>)[t.name] ?? (t.name === "ID" ? "id" : "string");
  // monday leaves some undescribed: then at least its name and type
  let description = (a.description ?? "").trim().replace(/\s+/g, " ") || `The ${a.name.replaceAll("_", " ")} (${gql(a.type)}).`;
  if (t.kind === "INPUT_OBJECT") {
    const fields = (t.inputFields ?? []).map((f) => `${f.name} (${gql(f.type)})${f.description ? `: ${f.description.trim().split("\n")[0]}` : ""}`).join("; ");
    description = `${description} ${list ? "A list of objects" : "An object"} (${t.name}) with: ${fields}`.slice(0, 1500);
  }
  if (kind === "json") description += " (JSON: an object, or the same as a JSON string)";
  if (kind === "file") description += ' A file from the computer: {"file": "/work/..."}';
  if (a.defaultValue !== null) description += ` Default: ${a.defaultValue}.`;
  return {
    name: a.name,
    gql: gql(a.type),
    type: kind,
    ...(list && { list }),
    ...(t.kind === "ENUM" && { values: (t.enumValues ?? []).filter((v) => !v.isDeprecated).map((v) => v.name) }),
    required: a.type.kind === "NON_NULL" && a.defaultValue === null,
    description: description.trim(),
  };
}

const skipped: string[] = [];
const actions = [];
for (const [kind, root] of [["query", "Query"], ["mutation", "Mutation"]] as const) {
  for (const f of types.get(root)!.fields ?? []) {
    const skip = SKIP[`${kind} ${f.name}`] ?? SKIP[f.name];
    if (skip) {
      skipped.push(`${kind} ${f.name}: ${skip}`);
      continue;
    }
    if (f.isDeprecated) {
      skipped.push(`${f.name}: deprecated by monday (${f.deprecationReason ?? "no reason given"})`);
      continue;
    }
    if (namespace(f)) {
      for (const sub of types.get(named(f.type).name!)!.fields ?? []) {
        if (sub.isDeprecated) continue;
        actions.push({
          name: `${f.name}_${sub.name}`,
          kind,
          parent: f.name,
          field: sub.name,
          description: (sub.description ?? `${f.name} ${sub.name}`).trim().replace(/\s+/g, " "),
          readOnly: kind === "query",
          returns: gql(sub.type),
          select: leaf(sub.type) ? "" : pick(named(sub.type).name!),
          args: sub.args.map(input),
        });
      }
      continue;
    }
    const ret = named(f.type).name!;
    const select = leaf(f.type) ? "" : pick(ret);
    actions.push({
      name: f.name,
      kind,
      description: (f.description ?? f.name.replaceAll("_", " ")).trim().replace(/\s+/g, " "),
      readOnly: kind === "query" && !SECRETS.has(f.name) && !WRITES.has(f.name),
      returns: gql(f.type),
      select,
      args: f.args.map(input),
    });
  }
}
await Bun.write(new URL("../../src/integrations/own/monday/actions.json", import.meta.url), JSON.stringify({ version: VERSION, actions }, null, 1));
console.log(`${actions.length} actions (API version ${VERSION}); skipped ${skipped.length}:\n  ${skipped.join("\n  ")}`);

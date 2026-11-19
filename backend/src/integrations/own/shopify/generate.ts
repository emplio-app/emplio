// Writes actions.json: one action per operation in Shopify's Admin GraphQL API (every query and mutation that isn't
// deprecated), each with its arguments as input and a default set of fields to return, sized to stay well inside
// Shopify's per-query cost limit. Run from backend/ when moving to a newer API version:
//   bun src/integrations/own/shopify/generate.ts
// The schema comes from shopify.dev's public GraphiQL proxy, which answers introspection without a store.
import { VERSION } from "./client";

type TypeRef = { kind: string; name: string | null; ofType: TypeRef | null };
type Arg = { name: string; description: string | null; type: TypeRef; defaultValue: string | null };
type Field = { name: string; description: string | null; args: Arg[]; type: TypeRef; isDeprecated: boolean };
type FullType = { kind: string; name: string; description: string | null; fields: Field[] | null; inputFields: Arg[] | null; enumValues: { name: string; isDeprecated: boolean }[] | null; possibleTypes: TypeRef[] | null; interfaces: TypeRef[] | null };

const REF = "kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }";
const INTROSPECT = `{ __schema { types { kind name description
  fields(includeDeprecated: true) { name description isDeprecated args { name description defaultValue type { ${REF} } } type { ${REF} } }
  inputFields { name description defaultValue type { ${REF} } }
  enumValues(includeDeprecated: true) { name isDeprecated }
  possibleTypes { name } interfaces { name } } } }`;

// Operations a store's own app can't use: app billing (only public apps charge), and the ones only tax or payments
// partners may call. COVERAGE.md lists them.
const SKIP = new Set([
  "appPurchaseOneTimeCreate", "appSubscriptionCancel", "appSubscriptionCreate", "appSubscriptionLineItemUpdate", "appSubscriptionTrialExtend",
  "appUsageRecordCreate", "taxAppConfigure", "taxSummaryCreate", "shopifyPaymentsPayoutAlternateCurrencyCreate", "financeAppAccessPolicy", "financeKycInformation",
]);
// mutations that only work something out and change nothing
const READS = new Set(["draftOrderCalculate", "draftOrderInvoicePreview", "subscriptionContractCreateCalculate", "subscriptionBillingCycleContractEditCalculate", "flowGenerateSignature"]);

// the last word of a mutation, put first: productCreate → create_product
const VERBS = new Set(
  "create update delete cancel close open complete activate deactivate duplicate approve send set add remove merge move split hold reschedule reorder publish unpublish capture commit begin calculate process request decline reopen enable disable pin unpin upsert register revoke assign credit debit charge skip unskip expire fail pause void submit accept reject release edit copy dispose receive sync configure resolve destroy upload preview reroute".split(" "),
);
const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(" ");
const snake = (s: string) => words(s).join("_");

const schema = (await (
  await fetch(`https://shopify.dev/admin-graphql-direct-proxy/${VERSION}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: INTROSPECT }) })
).json()) as { data: { __schema: { types: FullType[] } } };
const T = new Map(schema.data.__schema.types.map((t) => [t.name, t]));

const named = (t: TypeRef): string => (t.ofType ? named(t.ofType) : t.name!);
const gqlType = (t: TypeRef): string => (t.kind === "NON_NULL" ? `${gqlType(t.ofType!)}!` : t.kind === "LIST" ? `[${gqlType(t.ofType!)}]` : t.name!);
const required = (a: Arg) => a.type.kind === "NON_NULL" && a.defaultValue === null;
const kindOf = (name: string) => T.get(name)!.kind;
const isConnection = (name: string) => name.endsWith("Connection") && Boolean(T.get(name)?.fields?.some((f) => f.name === "nodes"));
const nodeType = (conn: string) => named(T.get(conn)!.fields!.find((f) => f.name === "nodes")!.type);

// Docs text, without links and markdown, cut at a sentence near `max`.
export function clean(text: string | null, max = 400) {
  let s = (text ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) {
    const cut = s.slice(0, max);
    const end = cut.lastIndexOf(". ");
    s = end > max / 3 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  }
  return s;
}

// A search argument's table of filters, as one line: name: values (e.g. example)
function filters(text: string) {
  const rows = text.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| name") && !l.startsWith("| ----"));
  const list = rows.map((r) => {
    const [name = "", , , values = "", , example = ""] = r.slice(2, -2).split(" | ").map((c) => c.trim());
    const vals = [...values.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const ex = /`([^`]+)`/.exec(example)?.[1];
    return vals.length ? `${name}: ${vals.join("|")}` : ex ? `${name} (${ex})` : name;
  });
  return `Shopify search syntax, e.g. status:open created_at:>2024-01-01; combine with AND/OR, negate with -. Filters: ${list.join(", ")}`;
}

// An input object's fields, as a compact signature the agent can fill in
const signature = (name: string) =>
  `${name} { ${(T.get(name)!.inputFields ?? []).map((f) => `${f.name}: ${gqlType(f.type)}`).join(", ")} }`;

function jsonType(t: TypeRef): Record<string, unknown> {
  if (t.kind === "NON_NULL") return jsonType(t.ofType!);
  if (t.kind === "LIST") return { type: "array", items: jsonType(t.ofType!) };
  const n = t.name!;
  const k = kindOf(n);
  if (k === "ENUM") return { type: "string", enum: T.get(n)!.enumValues!.filter((v) => !v.isDeprecated).map((v) => v.name) };
  if (k === "INPUT_OBJECT") return { type: "object", additionalProperties: true };
  if (n === "Int") return { type: "integer" };
  if (n === "Float") return { type: "number" };
  if (n === "Boolean") return { type: "boolean" };
  if (n === "JSON") return {};
  return { type: "string" };
}

function argSchema(a: Arg) {
  const n = named(a.type);
  let d = a.name === "query" && /\| name \|/.test(a.description ?? "") ? filters(a.description!) : clean(a.description, 300);
  if (n === "ID") d += " (a Shopify id like gid://shopify/Order/123)";
  if (kindOf(n) === "INPUT_OBJECT") d += ` Shape: ${clean(signature(n), 1500)}. get_graphql_type shows any type's fields.`;
  return { ...jsonType(a.type), description: d.trim() };
}

// ── default fields to return, kept inside Shopify's cost limit (an object costs 1; a connection 2 + first × its nodes)
const NESTED_FIRST = 5;
type Sel = { text: string; cost: number; first?: boolean };
const scalarish = (n: string) => ["SCALAR", "ENUM"].includes(kindOf(n));

// The fields of `type`, spending at most `budget` on objects below it. Cheapest sub-objects are taken first.
function select(type: string, budget: number, depth: number, connections: boolean): Sel {
  const t = T.get(type)!;
  if (t.kind === "UNION") {
    const ids = (t.possibleTypes ?? []).some((p) => T.get(p.name!)?.interfaces?.some((i) => i.name === "Node"));
    return { text: ids ? "__typename ... on Node { id }" : "__typename", cost: 0 };
  }
  const fields = (t.fields ?? []).filter((f) => !f.isDeprecated && !f.args.some(required));
  const parts = fields.filter((f) => scalarish(named(f.type))).map((f) => f.name);
  if (t.kind === "INTERFACE") parts.unshift("__typename");
  const options: Sel[] = [];
  for (const f of fields) {
    const n = named(f.type);
    if (scalarish(n) || depth >= 3) continue;
    if (isConnection(n)) {
      if (!connections) continue;
      const inner = select(nodeType(n), 4, depth + 1, false);
      options.push({ text: `${f.name}(first: ${NESTED_FIRST}) { nodes { ${inner.text} } }`, cost: 2 + NESTED_FIRST * (1 + inner.cost) });
    } else if (n.endsWith("Connection") || n === "PageInfo") continue;
    else {
      const inner = select(n, Math.min(budget, 6), depth + 1, false);
      // totals, prices and the customer come first: an order without them isn't much use
      const key = (/^Money/.test(n) && /(total|subtotal)price|^price|^amount|^balance|^initialvalue/i.test(f.name)) || f.name === "customer";
      if (inner.text) options.push({ text: `${f.name} { ${inner.text} }`, cost: 1 + inner.cost, first: key });
    }
  }
  let cost = 0;
  for (const o of options.sort((a, b) => Number(Boolean(b.first)) - Number(Boolean(a.first)) || a.cost - b.cost)) {
    if (cost + o.cost > budget) break;
    parts.push(o.text);
    cost += o.cost;
  }
  return { text: parts.join(" "), cost };
}

// a mutation's answer: what it made or changed, and the errors
function payload(type: string): string {
  const t = T.get(type)!;
  if (t.kind !== "OBJECT" || !type.endsWith("Payload")) return select(type, 300, 0, true).text;
  return (t.fields ?? [])
    .filter((f) => !f.isDeprecated && !f.args.some(required))
    .map((f) => {
      const n = named(f.type);
      if (scalarish(n)) return f.name;
      if (f.name === "userErrors") return `userErrors { ${select(n, 0, 2, false).text} }`;
      if (isConnection(n)) return `${f.name}(first: 50) { nodes { ${select(nodeType(n), 15, 1, false).text} } }`;
      const inner = select(n, 150, 1, true).text;
      return inner ? `${f.name} { ${inner} }` : "";
    })
    .filter(Boolean)
    .join(" ");
}

const FIELDS_HELP = "Optional: the GraphQL fields to return instead of the usual ones, e.g. \"id name totalPriceSet { shopMoney { amount currencyCode } }\"";

type Generated = { name: string; kind: "query" | "mutation"; field: string; description: string; readOnly: boolean; args: [string, string][]; input: object; select: string; list?: true };
const actions: Generated[] = [];

for (const [kind, root] of [["query", "QueryRoot"], ["mutation", "Mutation"]] as const) {
  for (const f of T.get(root)!.fields!) {
    if (f.isDeprecated || SKIP.has(f.name)) continue;
    const ret = named(f.type);
    const list = kind === "query" && isConnection(ret);
    const w = words(f.name);
    const name =
      kind === "mutation"
        ? VERBS.has(w.at(-1)!) && !w.slice(0, -1).some((x) => VERBS.has(x) || x === "or") ? [w.at(-1), ...w.slice(0, -1)].join("_") : snake(f.name)
        : list ? `list_${snake(f.name)}` : f.name.endsWith("Count") ? `count_${snake(f.name.slice(0, -5))}` : `get_${snake(f.name)}`;
    const properties: Record<string, unknown> = Object.fromEntries(f.args.map((a) => [a.name, argSchema(a)]));
    let select_ = "";
    if (list) {
      const node = nodeType(ret);
      select_ = `${scalarish(node) ? "nodes" : `nodes { ${select(node, 30, 1, false).text} }`} pageInfo { hasNextPage endCursor }`;
    }
    else if (!scalarish(ret)) select_ = kind === "mutation" ? payload(ret) : select(ret, 400, 0, true).text;
    if (select_) properties.fields = { type: "string", description: FIELDS_HELP };
    if (list) (properties.first as { description: string }).description = "How many to return, up to 250 (default 10). With many fields, ask for fewer";
    actions.push({
      name,
      kind,
      field: f.name,
      description: `${clean(f.description)}${list ? " Page on with after: pageInfo.endCursor." : ""}`,
      readOnly: kind === "query" || READS.has(f.name),
      args: f.args.map((a) => [a.name, gqlType(a.type)]),
      input: { type: "object", properties, required: f.args.filter(required).map((a) => a.name) },
      select: select_,
      ...(list && { list: true as const }),
    });
  }
}

const dupes = actions.map((a) => a.name).filter((n, i, all) => all.indexOf(n) !== i);
if (dupes.length) throw new Error(`two operations got the same name: ${dupes.join(", ")}`);
// the webhook topics, for triggers.ts
const topics = T.get("WebhookSubscriptionTopic")!.enumValues!.filter((v) => !v.isDeprecated).map((v) => v.name);
await Bun.write(new URL("./actions.json", import.meta.url), JSON.stringify({ version: VERSION, actions }));
await Bun.write(new URL("./topics.json", import.meta.url), `${JSON.stringify(topics, null, 1)}\n`);
console.log(`${actions.length} actions (${actions.filter((a) => a.readOnly).length} read-only), ${topics.length} webhook topics, skipped ${[...SKIP].join(", ")}`);

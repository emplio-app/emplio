// Linear: builds own/linear/actions.json from Linear's GraphQL schema, one action per query and mutation. Linear has no
// OpenAPI spec; its SDK repository publishes the schema. Run again when Linear's API grows:
//   cd backend && bun scripts/openapi/linear.ts [schema.graphql]
// (default: downloads github.com/linear/linear packages/sdk/src/schema.graphql)
// ponytail: a small SDL reader instead of the graphql package (not installed); it reads only what SDL files hold.

type TypeRef = { name: string; list: boolean; nonNull: boolean; itemNonNull: boolean; sdl: string };
type Value = { name: string; description: string; type: TypeRef; deprecated: boolean; hasDefault: boolean };
type Field = Value & { args: Value[] };
type Def = { kind: string; name: string; description: string; fields: Field[]; values: string[] };

const SOURCE = "https://raw.githubusercontent.com/linear/linear/master/packages/sdk/src/schema.graphql";
const OUT = new URL("../../src/integrations/own/linear/actions.json", import.meta.url);

function tokenize(src: string) {
  const out: string[] = [];
  const re = /\s+|,|#[^\n]*|("""[\s\S]*?""")|("(?:\\.|[^"\\])*")|(\.\.\.|[!$():=@\[\]{}|&])|([_A-Za-z][_0-9A-Za-z]*)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < src.length) {
    m = re.exec(src);
    if (!m) throw new Error("can't read the schema at " + src.slice(re.lastIndex, re.lastIndex + 40));
    const t = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (t !== undefined) out.push(t);
  }
  return out;
}

const unquote = (s: string) => (s.startsWith('"""') ? s.slice(3, -3).replace(/\n\s*/g, " ").trim() : JSON.parse(s) as string);

export function parse(src: string): Map<string, Def> {
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const next = () => t[i++]!;
  const expect = (s: string) => {
    if (t[i] !== s) throw new Error("expected " + s + " at token " + i + ", got " + t[i]);
    i++;
  };
  const desc = () => (peek()?.startsWith('"') ? unquote(next()) : "");
  const skipValue = (): void => {
    const s = next();
    if (s === "[" || s === "{") {
      const close = s === "[" ? "]" : "}";
      while (peek() !== close) {
        if (s === "{") (next(), expect(":"));
        skipValue();
      }
      next();
    }
  };
  // directives; answers whether one was @deprecated
  const directives = () => {
    let deprecated = false;
    while (peek() === "@") {
      next();
      if (next() === "deprecated") deprecated = true;
      if (peek() === "(") {
        next();
        while (peek() !== ")") (next(), expect(":"), skipValue());
        next();
      }
    }
    return deprecated;
  };
  const type = (): TypeRef => {
    if (peek() === "[") {
      next();
      const inner = type();
      expect("]");
      const nonNull = peek() === "!" && Boolean(next());
      return { name: inner.name, list: true, nonNull, itemNonNull: inner.nonNull, sdl: "[" + inner.sdl + "]" + (nonNull ? "!" : "") };
    }
    const name = next();
    const nonNull = peek() === "!" && Boolean(next());
    return { name, list: false, nonNull, itemNonNull: false, sdl: name + (nonNull ? "!" : "") };
  };
  const value = (): Value => {
    const description = desc();
    const name = next();
    expect(":");
    const ty = type();
    let hasDefault = false;
    if (peek() === "=") (next(), skipValue(), (hasDefault = true));
    return { name, description, type: ty, deprecated: directives(), hasDefault };
  };
  const field = (): Field => {
    const description = desc();
    const name = next();
    const args: Value[] = [];
    if (peek() === "(") {
      next();
      while (peek() !== ")") args.push(value());
      next();
    }
    expect(":");
    const ty = type();
    return { name, description, type: ty, args, deprecated: directives(), hasDefault: false };
  };
  const defs = new Map<string, Def>();
  while (i < t.length) {
    const description = desc();
    const kind = next();
    if (kind === "schema") {
      while (next() !== "}");
      continue;
    }
    if (kind === "directive") {
      expect("@");
      next();
      if (peek() === "(") {
        next();
        while (peek() !== ")") value();
        next();
      }
      if (peek() === "repeatable") next();
      expect("on");
      if (peek() === "|") next();
      next();
      while (peek() === "|") (next(), next());
      continue;
    }
    const name = next();
    const def: Def = { kind, name, description, fields: [], values: [] };
    if (kind === "type" || kind === "interface") {
      if (peek() === "implements") {
        next();
        if (peek() === "&") next();
        next();
        while (peek() === "&") (next(), next());
      }
      directives();
      if (peek() === "{") {
        next();
        while (peek() !== "}") def.fields.push(field());
        next();
      }
    } else if (kind === "input") {
      directives();
      expect("{");
      while (peek() !== "}") def.fields.push({ ...value(), args: [] });
      next();
    } else if (kind === "enum") {
      directives();
      expect("{");
      while (peek() !== "}") {
        desc();
        const v = next();
        if (!directives()) def.values.push(v);
      }
      next();
    } else if (kind === "union") {
      directives();
      expect("=");
      if (peek() === "|") next();
      def.values.push(next());
      while (peek() === "|") (next(), def.values.push(next()));
    } else if (kind === "scalar") directives();
    else throw new Error("unknown definition " + kind + " " + name);
    defs.set(name, def);
  }
  return defs;
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase();
const NUMBER: Record<string, string> = { Int: "integer", Float: "number", Boolean: "boolean" };
// what each of Linear's own scalars looks like
const SCALARS: Record<string, string> = {
  DateTime: "a date and time, ISO 8601",
  TimelessDate: "a date, YYYY-MM-DD",
  DateTimeOrDuration: "a date and time, or an ISO 8601 duration like P2W",
  TimelessDateOrDuration: "a date, or an ISO 8601 duration like P1D",
  Duration: "an ISO 8601 duration like PT1H",
  UUID: "a UUID",
};
// fields left out of what comes back unless asked for: secrets
const SECRET = /secret|token|password/i;
// names a reference is shown by
const LABELS = ["name", "title", "displayName", "key", "identifier", "email", "url", "body"];

export function build(src: string) {
  const defs = parse(src);
  const def = (n: string) => defs.get(n);
  const isObject = (n: string) => ["type", "interface"].includes(def(n)?.kind ?? "");
  const isConnection = (n: string) => Boolean(def(n)?.fields.some((f) => f.name === "nodes") && def(n)?.fields.some((f) => f.name === "pageInfo"));

  // JSON schema for one argument or input field; input objects deeper than the first level stay loose objects
  // whose description lists their fields, so the action list stays small and filters stay free-form
  const schema = (ty: TypeRef, description: string, depth: number): Record<string, unknown> => {
    const one = (): Record<string, unknown> => {
      const d = def(ty.name);
      if (NUMBER[ty.name]) return { type: NUMBER[ty.name] };
      if (d?.kind === "enum") return { type: "string", enum: d.values };
      if (d?.kind === "input") {
        const fields = d.fields.filter((f) => !f.deprecated);
        if (depth > 0) return { type: "object", properties: Object.fromEntries(fields.map((f) => [f.name, schema(f.type, f.description, depth - 1)])), required: fields.filter((f) => f.type.nonNull && !f.hasDefault).map((f) => f.name) };
        return { type: "object", description: ty.name + " with any of: " + fields.map((f) => f.name).join(", ") };
      }
      if (ty.name === "JSON" || ty.name === "JSONObject") return {};
      return { type: "string", ...(SCALARS[ty.name] && { description: SCALARS[ty.name] }) };
    };
    const item = one();
    const s: Record<string, unknown> = ty.list ? { type: "array", items: item } : item;
    const extra = [description, (!ty.list && (item.description as string)) || ""].filter(Boolean).join(" ").trim();
    if (extra) s.description = extra;
    if (ty.list) delete (item as { description?: string }).description;
    return s;
  };

  // what comes back by default: the plain fields, and references as their id and name; a payload's record in full
  const selection = (name: string, depth: number): string => {
    const d = def(name);
    if (!d) return "";
    if (d.kind === "union") return "__typename " + d.values.map((v) => "... on " + v + " { id }").join(" ");
    if (isConnection(name)) {
      const node = d.fields.find((f) => f.name === "nodes")!.type.name;
      return "nodes { " + selection(node, depth) + " } pageInfo { hasNextPage endCursor }";
    }
    const parts: string[] = [];
    for (const f of d.fields) {
      if (f.deprecated || f.args.some((a) => a.type.nonNull && !a.hasDefault) || SECRET.test(f.name)) continue;
      const k = def(f.type.name)?.kind;
      if (!k || k === "scalar" || k === "enum") parts.push(f.name);
      else if (isObject(f.type.name) && !isConnection(f.type.name) && !f.type.list) {
        if (depth > 0) parts.push(f.name + " { " + selection(f.type.name, depth - 1) + " }");
        else if (def(f.type.name)!.fields.some((x) => x.name === "id")) {
          const labels = LABELS.filter((l) => def(f.type.name)!.fields.some((x) => x.name === l && !x.deprecated && !x.args.length && !def(x.type.name)?.fields.length));
          parts.push(f.name + " { id" + (labels.length ? " " + labels.join(" ") : "") + " }");
        }
      }
    }
    return parts.join(" ") || "__typename";
  };

  const actions: unknown[] = [];
  const skipped: Record<string, string> = {};
  for (const [kind, root] of [["query", "Query"], ["mutation", "Mutation"]] as const) {
    for (const f of def(root)!.fields) {
      if (f.name.startsWith("_")) continue;
      if (f.deprecated) {
        skipped[f.name] = "Linear marks it deprecated";
        continue;
      }
      const ret = f.type.name;
      const name = kind === "mutation" ? snake(f.name) : (isConnection(ret) ? "list_" : "get_") + snake(f.name);
      // one input object argument and nothing that clashes: its fields become the action's own
      const inputArg = f.args.find((a) => a.name === "input" && def(a.type.name)?.kind === "input" && !a.type.list);
      const lift = inputArg && def(inputArg.type.name)!.fields.filter((x) => !x.deprecated);
      const clash = lift?.some((x) => f.args.some((a) => a.name === x.name) || x.name === "select");
      const props: Record<string, unknown> = {};
      const required: string[] = [];
      for (const a of f.args) {
        if (a.deprecated) continue;
        if (a === inputArg && lift && !clash) {
          for (const x of lift) {
            props[x.name] = schema(x.type, x.description, 1);
            // a change can clear a field ("pass null to unassign")
            const p = props[x.name] as { type?: unknown };
            if (f.name.endsWith("Update") && !x.type.nonNull && typeof p.type === "string" && p.type !== "array") p.type = [p.type, "null"];
            if (x.type.nonNull && !x.hasDefault) required.push(x.name);
          }
          continue;
        }
        props[a.name] = schema(a.type, a.description, a === inputArg ? 2 : 1);
        if (a.type.nonNull && !a.hasDefault) required.push(a.name);
      }
      const sel = isObject(ret) || def(ret)?.kind === "union" ? selection(ret, kind === "mutation" ? 1 : 0) : "";
      if (sel) props.select = { type: "string", description: "What to get back, as a GraphQL selection, e.g. \"id title state { name }\"; leave out for the usual fields" };
      actions.push({
        name,
        field: f.name,
        kind,
        description: (f.description || (kind === "query" ? "Look up " : "Change ") + f.name) + (kind === "query" && isConnection(ret) ? " Pages with first and after (pageInfo.endCursor)." : ""),
        readOnly: kind === "query",
        input: { type: "object", properties: props, required },
        ...(lift && !clash && { lift: lift.map((x) => x.name), liftType: inputArg!.type.sdl }),
        vars: f.args.filter((a) => !a.deprecated).map((a) => "$" + a.name + ": " + a.type.sdl).join(", "),
        args: f.args.filter((a) => !a.deprecated).map((a) => a.name + ": $" + a.name).join(", "),
        select: sel,
      });
    }
  }
  return { actions, skipped };
}

if (import.meta.main) {
  const from = process.argv[2];
  const src = from ? await Bun.file(from).text() : await (await fetch(SOURCE)).text();
  const { actions, skipped } = build(src);
  await Bun.write(OUT, JSON.stringify({ source: SOURCE, generated: new Date().toISOString().slice(0, 10), skipped, actions }, null, 0));
  console.log(actions.length + " actions; skipped (deprecated): " + Object.keys(skipped).join(", "));
}

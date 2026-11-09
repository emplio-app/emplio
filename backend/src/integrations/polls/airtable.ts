import { z } from "zod";
import type { PollTrigger, Run } from "./index";

// Airtable webhooks stop after 7 days and need a cursor kept, so everything is polled (COVERAGE.md).
const DAY = "DATEADD(NOW(), -1, 'days')";
// cells Airtable works out itself: a change in one of these isn't an edit to the record
const COMPUTED = new Set(["formula", "rollup", "multipleLookupValues", "count", "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy", "autoNumber", "button", "externalSyncSource", "aiText"]);
const stamp = (v: unknown) => Bun.hash(JSON.stringify(v)).toString(36);

const baseConfig = { base_id: z.string().describe("The base's id, starting app...") };
const viewConfig = { ...baseConfig, table: z.string().optional().describe("Only this table (name or id)") };
const recordConfig = {
  base_id: z.string().describe("The base's id, starting app..."),
  table: z.string().describe("The table (name or id)"),
  view: z.string().optional().describe("Only records in this view"),
  formula: z.string().optional().describe('Only records where this Airtable formula is true, e.g. {Status} = "Open"'),
};
type RecordConfig = z.infer<z.ZodObject<typeof recordConfig>>;

const schema = async (run: Run, base_id: string) => ((await run("airtable.get_base_schema", { base_id })) as { tables?: any[] }).tables ?? [];
// every view in the base, each with its table
const views = async (run: Run, config: { base_id: string; table?: string }) =>
  (await schema(run, config.base_id))
    .filter((t) => !config.table || t.id === config.table || t.name === config.table)
    .flatMap((t) => (t.views ?? []).map((view: any) => ({ view, table: { id: t.id, name: t.name } })));

// ponytail: 5 pages of 100 records from the last day; a table changing faster than that between checks misses some
async function records(run: Run, { base_id, table, view, formula }: RecordConfig, recent: string) {
  const out: any[] = [];
  const filterByFormula = formula ? `AND(${recent}, ${formula})` : recent;
  let offset: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res = (await run("airtable.list_records", { base_id, table, filterByFormula, pageSize: 100, ...(view && { view }), ...(offset && { offset }) })) as { records?: any[]; offset?: string };
    out.push(...(res.records ?? []));
    offset = res.offset;
    if (!offset) break;
  }
  return out;
}

const output = (name: string, description: string): PollTrigger["output"] => [{ name, type: "object", required: true, description }];
const viewOut: PollTrigger["output"] = [...output("view", "The Airtable view: id, name, type"), ...output("table", "Its table: id, name")];
const recordOut = output("record", "The Airtable record: id, createdTime, fields");

// What's gone can't be seen in today's list, so the last list of each base is kept here and compared; a deletion is remembered for a day so every automation on the base gets it.
// ponytail: in memory, one server; a view deleted while the server is down isn't noticed. Keep it in Postgres if there's ever more than one machine
const lastViews = new Map<string, { views: Map<string, any>; gone: { id: string; at: number; item: any }[] }>();

export const airtable: Record<string, PollTrigger> = {
  new_record: {
    description: "A record is added to an Airtable table (checked every 5 minutes by default).",
    config: z.object(recordConfig),
    output: recordOut,
    every: 5,
    min: 1,
    async poll(config, run) {
      return (await records(run, config, `IS_AFTER(CREATED_TIME(), ${DAY})`)).map((record) => ({ id: record.id, item: { record } }));
    },
  },
  record_updated: {
    description: "A record is changed after it was added (cells Airtable works out itself, like formulas, don't count).",
    config: z.object(recordConfig),
    output: recordOut,
    every: 5,
    min: 1,
    async poll(config, run) {
      const tables = await schema(run, config.base_id);
      const t = tables.find((x) => x.id === config.table || x.name === config.table);
      const computed = new Set((t?.fields ?? []).filter((f: any) => COMPUTED.has(f.type)).map((f: any) => f.name));
      const edited = await records(run, config, `AND(IS_AFTER(LAST_MODIFIED_TIME(), ${DAY}), DATETIME_DIFF(LAST_MODIFIED_TIME(), CREATED_TIME(), 'seconds') > 5)`);
      return edited.map((record) => ({ id: `${record.id}:${stamp(Object.entries(record.fields ?? {}).filter(([k]) => !computed.has(k)).sort(([a], [b]) => a.localeCompare(b)))}`, item: { record } }));
    },
  },
  base_metadata_changed_trigger: {
    description: "A base's name or your permission on it changes. A base newly shared with this token counts as well.",
    config: z.object({}),
    output: output("base", "The base: id, name, permissionLevel"),
    every: 15,
    min: 5,
    async poll(_c, run) {
      const bases: any[] = [];
      let offset: string | undefined;
      do {
        const res = (await run("airtable.list_bases", offset ? { offset } : {})) as { bases?: any[]; offset?: string };
        bases.push(...(res.bases ?? []));
        offset = res.offset;
      } while (offset);
      return bases.map((base) => ({ id: `${base.id}:${stamp([base.name, base.permissionLevel])}`, item: { base } }));
    },
  },
  base_schema_changed_trigger: {
    description: "Tables, fields or views change in a base.",
    config: z.object(baseConfig),
    output: [
      { name: "base_id", type: "string", required: true, description: "The base" },
      { name: "tables", type: "array", required: true, description: "The base's tables as they are now, with fields and views" },
    ],
    every: 15,
    min: 5,
    async poll({ base_id }, run) {
      const tables = await schema(run, base_id);
      return [{ id: `${base_id}:${stamp(tables)}`, item: { base_id, tables } }];
    },
  },
  user_profile_changed_trigger: {
    description: "The connected Airtable user's id, email or token scopes change.",
    config: z.object({}),
    output: output("user", "The user: id, email, scopes"),
    every: 60,
    min: 15,
    async poll(_c, run) {
      const user = await run("airtable.who_am_i", {});
      return [{ id: stamp(user), item: { user } }];
    },
  },
  view_created_trigger: {
    description: "A view is added in a base.",
    config: z.object(viewConfig),
    output: viewOut,
    every: 15,
    min: 5,
    async poll(config, run) {
      return (await views(run, config)).map(({ view, table }) => ({ id: view.id, item: { view, table } }));
    },
  },
  view_metadata_changed_trigger: {
    description: "A view's name or type changes. A brand-new view counts as well.",
    config: z.object(viewConfig),
    output: viewOut,
    every: 15,
    min: 5,
    async poll(config, run) {
      return (await views(run, config)).map(({ view, table }) => ({ id: `${view.id}:${stamp([view.name, view.type])}`, item: { view, table } }));
    },
  },
  view_deleted_trigger: {
    description: "A view is deleted from a base. Noticed by comparing with the last check, so a deletion while Emplio's server is restarting can be missed.",
    config: z.object(viewConfig),
    output: viewOut,
    every: 15,
    min: 5,
    async poll(config, run) {
      const now = Date.now();
      const current = new Map((await views(run, { base_id: config.base_id })).map((v) => [v.view.id as string, v]));
      const was = lastViews.get(config.base_id);
      const state = was ?? { views: current, gone: [] };
      if (was) for (const [id, v] of was.views) if (!current.has(id)) state.gone.push({ id, at: now, item: v });
      state.views = current;
      state.gone = state.gone.filter((g) => now - g.at < 86_400_000);
      lastViews.set(config.base_id, state);
      const wanted = state.gone.filter((g) => !config.table || g.item.table.id === config.table || g.item.table.name === config.table);
      return wanted.map((g) => ({ id: g.id, item: g.item }));
    },
  },
};

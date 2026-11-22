// Writes actions.json: one action per operation in Harvest's API v2. Harvest publishes no OpenAPI spec, so this reads
// its reference pages (help.getharvest.com/api-v2): each "## <operation>" section has the method and path in a code
// block and its parameters in a table. Run from backend/ when Harvest adds to the API, then read what it printed:
//   bun src/integrations/own/harvest/generate.ts
const DOCS = "https://help.getharvest.com";

// Harvest's titles, made into names; Composio's names where it has the action, so automations carry over
const RENAME: Record<string, string> = {
  list_contacts: "list_client_contacts",
  get_contact: "get_client_contact",
  create_contact: "create_client_contact",
  update_contact: "update_client_contact",
  delete_contact: "delete_client_contact",
  get_company: "get_company_info",
  update_company: "update_company_info",
  list_messages_for_estimate: "list_estimate_messages",
  mark_draft_estimate_as_sent: "mark_estimate_as_sent",
  mark_open_estimate_as_accepted: "mark_estimate_as_accepted",
  mark_open_estimate_as_declined: "mark_estimate_as_declined",
  re_open_closed_estimate: "reopen_estimate",
  availability_heatmap: "get_availability_heatmap",
  get_settings: "get_forecast_settings",
  update_caller_financials_preference: "update_my_financials_preference",
  update_caller_weekly_digest_subscription: "update_my_weekly_digest_subscription",
  list_milestones_in_window: "list_milestones",
  schedule_export: "export_schedule",
  list_time_off_layer: "list_forecast_time_off",
  download_csv_errors_for_import: "download_import_csv_errors",
  create_user_mapping: "create_gusto_user_mapping",
  bulk_create_user_mappings: "bulk_create_gusto_user_mappings",
  delete_user_mapping: "delete_gusto_user_mapping",
  preview_sync_run: "preview_gusto_sync_run",
  create_sync_run: "create_gusto_sync_run",
  get_sync_run: "get_gusto_sync_run",
  list_messages_for_invoice: "list_invoice_messages",
  create_and_send_invoice_message: "create_invoice_message",
  get_invoice_message_subject_and_body_for_specific_invoice: "get_invoice_message_template",
  mark_draft_invoice_as_sent: "mark_invoice_as_sent",
  mark_open_invoice_as_closed: "mark_invoice_as_closed",
  re_open_closed_invoice: "reopen_invoice",
  mark_open_invoice_as_draft: "mark_invoice_as_draft",
  list_payments_for_invoice: "list_invoice_payments",
  create_free_form_invoice: "create_invoice",
  create_invoice_based_on_tracked_time_and_expenses: "create_invoice_from_tracked_time",
  get_unread_count: "get_unread_notification_count",
  peek_at_notifications: "peek_notifications",
  mark_notifications_as_read: "mark_all_notifications_as_read",
  list_task_assignments_for_specific_project: "list_project_task_assignments",
  list_user_assignments_for_specific_project: "list_project_user_assignments",
  update_user_assignments: "update_time_off_assignments",
  list_user_allocations: "list_time_off_allocations",
  update_or_reset_user_allocation: "update_time_off_allocation",
  bulk_update_user_allocations: "bulk_update_time_off_allocations",
  list_entries_in_holiday_calendar: "list_holiday_calendar_entries",
  create_entry_in_holiday_calendar: "create_holiday_calendar_entry",
  time_detailed_report: "get_detailed_time_report",
  expense_detailed_report: "get_detailed_expense_report",
  expense_categories_report: "get_expense_report_by_category",
  tasks_report: "get_time_report_by_task",
  profitability_report: "get_profitability_report",
  project_budget_report: "get_project_budget_report",
  uninvoiced_report: "get_uninvoiced_report",
  create_time_entry_via_duration: "create_time_entry",
  create_time_entry_via_start_and_end_time: "create_time_entry_with_start_and_end",
  restart_stopped_time_entry: "restart_time_entry",
  stop_running_time_entry: "stop_time_entry",
  list_billable_rates_for_specific_user: "list_billable_rates",
  list_cost_rates_for_specific_user: "list_cost_rates",
  list_active_project_assignments: "list_user_project_assignments",
  list_active_project_assignments_for_currently_authenticated_user: "list_my_project_assignments",
  list_assigned_teammates_for_specific_user: "list_user_teammates",
  update_user_assigned_teammates: "update_user_teammates",
  get_currently_authenticated_user: "get_me",
};
// the same title on two pages
const RENAME_PATH: Record<string, string> = {
  "GET /v2/pto/assignments": "list_time_off_assignments",
  "GET /v2/reports/expenses/clients": "get_expense_report_by_client",
  "GET /v2/reports/expenses/projects": "get_expense_report_by_project",
  "GET /v2/reports/expenses/team": "get_expense_report_by_team_member",
  "GET /v2/reports/time/clients": "get_time_report_by_client",
  "GET /v2/reports/time/projects": "get_time_report_by_project",
  "GET /v2/reports/time/team": "get_time_report_by_team_member",
};
// sections whose code block isn't an operation of their own
const SKIP: Record<string, string> = {
  "Access Roles": "a table of role names, not an operation",
  update_notification_preferences_with_put: "the same as update_notification_preferences (PATCH)",
};
// POSTs that only work something out
const READS = new Set(["generate_report", "preview_gusto_sync_run", "create_report_export"]);
// operations that are one PATCH/POST with a fixed field
const FIXED: Record<string, Record<string, unknown>> = { archive_user: { is_active: false } };

type Schema = Record<string, any>;
const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;|[“”]/g, '"')
    .replace(/&#39;|&rsquo;|’/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const cut = (s: string, max = 600) => (s.length > max ? s.slice(0, s.lastIndexOf(". ", max) + 1 || max) : s);
const snake = (title: string) =>
  title
    .toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/^retrieve\b/, "get")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !["a", "an", "the", "all"].includes(w))
    .join("_");

function tables(html: string) {
  return [...html.matchAll(/<table>([\s\S]*?)<\/table>/g)].map((t) => ({
    heads: [...t[1]!.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => decode(x[1]!)),
    rows: [...t[1]!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => decode(x[1]!))).filter((r) => r.length),
  }));
}
type Row = { name: string; type: string; required: boolean; description: string };
const rows = (t: { heads: string[]; rows: string[][] }): Row[] => {
  const req = t.heads.indexOf("Required");
  return t.rows.map((r) => {
    // the last filled cell: a few rows have an empty one at the end
    const description = r.filter(Boolean).at(-1)!;
    return { name: r[0]!, type: r[1]!, required: req >= 0 ? r[req] === "required" : /^Required\b/.test(description), description };
  });
};

function schemaOf(row: Row, nullable: boolean): Schema {
  const t = row.type.toLowerCase();
  const hint = t === "date" ? " (YYYY-MM-DD)" : t === "datetime" ? " (ISO 8601 date and time, e.g. 2026-11-22T10:00:00Z)" : t === "time" ? " (time of day, e.g. 8:00am or 13:30)" : "";
  const description = cut(row.description) + hint;
  if (t === "file") return { description: description + ' A file from the computer: {"file": "/work/..."}' };
  let s: Schema;
  if (t === "integer") s = { type: "integer" };
  else if (t === "decimal") s = { type: "number" };
  else if (t === "boolean") s = { type: "boolean" };
  else if (t.includes(" or ")) s = { anyOf: [{ type: "integer" }, { type: "string" }] };
  else if (t.includes("array")) s = { type: "array", items: /integer|ids/.test(t) ? { type: "integer" } : /string/.test(t) ? { type: "string" } : /object/.test(t) ? { type: "object" } : {} };
  else if (t === "object") s = { type: "object" };
  else s = { type: "string" };
  // updates take null to clear a field
  if (nullable && s.type) s.type = [s.type, "null"];
  return { ...s, description };
}

// a nested table (line items, recipients, the time import…) written into its parent field's description
const nested = (title: string, t: { heads: string[]; rows: string[][] }) =>
  title + ": " + rows(t).map((r) => r.name + " (" + r.type + (r.required ? ", required" : "") + "): " + cut(r.description, 300)).join("; ");
const parentOf: Record<string, string> = { "Line Item": "line_items", Recipient: "recipients", "Line Items Import": "line_items_import", "Time Import": "line_items_import", "Expense Import": "line_items_import" };

const index = await (await fetch(DOCS + "/api-v2/")).text();
const pages = [...new Set([...index.matchAll(/href="(\/api-v2\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/)"/g)].map((m) => m[1]!))].filter(
  // the overview repeats the other forecast pages; introduction and authentication have no operations
  (p) => !/introduction|authentication|forecast-overview/.test(p),
);

const actions: any[] = [];
const skipped: string[] = [];
const names = new Set<string>();
for (const page of pages) {
  const html = await (await fetch(DOCS + page)).text();
  const group = page.split("/")[4]!;
  const body = html.split('class="post-title"')[1]?.split("Still have questions")[0] ?? "";
  for (const part of body.split(/<h[23] id="/).slice(1)) {
    const title = decode(part.slice(part.indexOf(">") + 1, part.search(/<\/h[23]>/)));
    const op = part.match(/<code>\s*(GET|POST|PATCH|PUT|DELETE)\s+(\/v2\/[^\s<]+)/);
    if (!op) continue;
    const [, method, path] = op as unknown as [string, string, string];
    let name = RENAME_PATH[method + " " + path] ?? RENAME[snake(title)] ?? snake(title);
    const why = SKIP[title] ?? SKIP[name];
    if (why) {
      skipped.push(method + " " + path + " (" + title + "): " + why);
      continue;
    }
    if (names.has(name)) throw new Error("two operations named " + name + "; add one to RENAME_PATH");
    names.add(name);
    const intro = [...part.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => decode(m[1]!)).find((p) => p && !p.startsWith("Returns a") ) ?? "";
    const returns = [...part.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => decode(m[1]!)).find((p) => p.startsWith("Returns a")) ?? "";
    const description = cut([title + ".", intro, returns].filter(Boolean).join(" "), 500);

    const properties: Schema = {};
    const required: string[] = [];
    const sendPath = path.replace(/\{(\w+)\}/g, (_, k: string) => "{" + k.toLowerCase() + "}");
    for (const [, k] of sendPath.matchAll(/\{(\w+)\}/g)) {
      properties[k!] = { anyOf: [{ type: "integer" }, { type: "string" }], description: "The " + k!.replace(/_id$/, "").replace(/_/g, " ") + "'s id" };
      required.push(k!);
    }
    const bodyless = method === "GET" || method === "DELETE";
    const all = tables(part);
    // parameter tables; GET/DELETE "Attribute" tables describe the answer, not the request
    const params = all.filter((t) => t.heads[0] === "Parameter" || (t.heads[0] === "Attribute" && !bodyless));
    const main = params[0];
    const inQuery: string[] = [];
    const arrays: string[] = [];
    let file = false;
    if (main) {
      for (const row of rows(main)) {
        if (!/^[a-z_][a-z0-9_]*$/.test(row.name)) continue;
        // "Pass "send" to mark the invoice as sent": always that value
        const fixed = row.description.match(/^Pass "([\w-]+)" to/);
        properties[row.name] = fixed
          ? { type: "string", enum: [fixed[1]], default: fixed[1], description: row.description }
          : schemaOf(row, method === "PATCH" && !row.required);
        if (row.required && !fixed) required.push(row.name);
        if (row.type === "file") file = true;
        if (bodyless) {
          inQuery.push(row.name);
          if (row.type.includes("array")) arrays.push(row.name);
        }
      }
      // a second plain Parameter table is what each item of the first's array holds
      for (const extra of params.slice(1)) {
        const parent = rows(main).find((r) => /array|object/.test(r.type));
        if (parent) properties[parent.name].description += " Each item: " + nested("", extra).slice(2);
      }
    }
    for (const t of all) {
      const kind = t.heads[0]!.replace(/ Parameter$/, "");
      const parent = parentOf[kind];
      if (!t.heads[0]!.endsWith(" Parameter") || !parent || !properties[parent]) continue;
      properties[parent].description += " " + nested(kind === "Line Item" || kind === "Recipient" ? "Each item" : kind === "Line Items Import" ? "Fields" : '"' + (kind === "Time Import" ? "time" : "expenses") + '" holds', t);
    }
    for (const [k, v] of Object.entries(FIXED[name] ?? {})) properties[k] = { const: v, default: v, description: "Always " + JSON.stringify(v) };
    const fields = Object.keys(properties).filter((k) => !inQuery.includes(k) && !sendPath.includes("{" + k + "}"));
    actions.push({
      name,
      group,
      description,
      readOnly: method === "GET" || READS.has(name),
      input: { type: "object", properties, required },
      send: {
        method,
        path: sendPath.replace(/^\/v2/, ""),
        query: inQuery.map((k) => (arrays.includes(k) ? k + "[]" : k)),
        headers: [],
        ...(fields.length && { body: { kind: file ? "form" : "fields", fields: fields.map((k) => [k, k]) } }),
      },
      // array query params go as name[]=1&name[]=2
      ...(arrays.length && { arrays }),
    });
  }
}
await Bun.write(new URL("./actions.json", import.meta.url), JSON.stringify({ generated: new Date().toISOString().slice(0, 10), source: DOCS + "/api-v2/", skipped, actions }, null, 1) + "\n");
console.log(actions.length + " actions from " + pages.length + " pages");
for (const s of skipped) console.log("skipped " + s);

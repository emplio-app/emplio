// Toggl Track: what the generator (../openapi-actions.ts) can't tell from the specs. Toggl publishes three Swagger 2.0
// files (Track API v9, Reports API v3 with Insights, Webhooks API v1), linked from its docs' Open API page. The
// generator reads OpenAPI 3, so each is turned into that shape here first: body and form params become a requestBody,
// the rest get a schema, and every operation gets an id (Reports has none).
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";

type Schema = Record<string, any>;
const DOCS = "https://engineering.toggl.com/docs/track/openapi/";
const HOST = "https://api.track.toggl.com";
const KEEP = ["type", "items", "enum", "default", "minimum", "maximum", "format"];

// the files' names carry a hash that changes with every docs release, so they're read off the page
const page = await (await fetch(DOCS)).text();
const link = (name: string) => {
  const m = page.match(new RegExp(`/assets/files/${name}-[0-9a-f]+\\.json`));
  if (!m) throw new Error(`no ${name} spec linked from ${DOCS}`);
  return `https://engineering.toggl.com${m[0]}`;
};

// an operation id from the call, for the ones the spec leaves without: POST /workspaces/{workspace_id}/goals → post-workspaces-goals
const idFor = (method: string, path: string) =>
  [method, ...path.replace(/^\/(reports\/api\/v3|insights\/api\/v1)\/(workspace\/\{workspace_id\}\/)?/, (_, api) => `${api.startsWith("insights") ? "insights" : "reports"}/`).split(/[/.]/)]
    .map((p) => p.replace(/[{}]/g, ""))
    .filter((p) => p && p !== "workspaces" && p !== "workspace_id")
    .join("-");

function convert(spec: Schema, name: string, server?: string): Schema {
  for (const [path, ops] of Object.entries<Schema>(spec.paths)) {
    for (const [method, op] of Object.entries<Schema>(ops)) {
      op.operationId ??= idFor(method, path);
      op["x-spec"] = name;
      const params: Schema[] = op.parameters ?? [];
      const body = params.filter((p) => p.in === "body");
      const form = params.filter((p) => p.in === "formData");
      const bodyless = method === "get" || method === "delete";
      op.parameters = params
        .filter((p) => p.in !== "body" && (p.in !== "formData" || bodyless))
        .map((p) => ({
          name: p.name,
          in: p.in === "formData" ? "query" : p.in,
          required: p.required,
          description: p.description,
          // Swagger 2 sends a query array comma separated unless it says "multi"
          explode: p.type === "array" ? p.collectionFormat === "multi" : undefined,
          schema: Object.fromEntries(KEEP.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])),
        }));
      if (body.length === 1) {
        op.requestBody = { required: body[0]!.required, content: { "application/json": { schema: { ...body[0]!.schema, description: body[0]!.schema?.description ?? body[0]!.description } } } };
      } else if (body.length) {
        // Reports' saved-report calls list each body field as its own body param
        const properties = Object.fromEntries(body.map((p) => [p.name, { ...(p.schema ?? {}), description: p.description }]));
        op.requestBody = { content: { "application/json": { schema: { type: "object", properties, required: body.filter((p) => p.required).map((p) => p.name) } } } };
      } else if (form.length && !bodyless) {
        const files = form.some((p) => p.type === "file" || p.name === "file");
        const properties = Object.fromEntries(form.map((p) => [p.name, p.type === "file" || p.name === "file" ? { format: "binary", description: p.description } : { type: p.type, description: p.description }]));
        const type = files ? "multipart/form-data" : "application/x-www-form-urlencoded";
        op.requestBody = { content: { [type]: { schema: { type: "object", properties, required: form.filter((p) => p.required).map((p) => p.name) } } } };
      }
    }
  }
  if (server) spec.servers = [{ url: server }];
  return spec;
}

const specs = await Promise.all(
  [
    ["api", undefined],
    ["reports", HOST],
    ["webhooks", `${HOST}/webhooks/api/v1`],
  ].map(async ([name, server]) => {
    const file = `${tmpdir()}/toggl-${name}.json`;
    await Bun.write(file, JSON.stringify(convert(await (await fetch(link(name!))).json(), name!, server)));
    return file;
  }),
);

// Composio's names for the same calls, so skills and automations made on Composio carry over; the rest keep Toggl's ids
const NAMES: Record<string, string> = {
  "POST /workspaces/{workspace_id}/clients": "create_client",
  "POST /organizations/{organization_id}/groups": "create_group",
  "POST /organizations/{organization_id}/invitations": "create_invitation",
  "POST /organizations": "create_organization",
  "POST /workspaces/{workspace_id}/projects": "create_project",
  "POST /workspaces/{workspace_id}/tags": "create_tag",
  "POST /workspaces/{workspace_id}/time_entries": "create_time_entry",
  "POST /workspaces/{workspace_id}/project_users": "create_workspaces_project_users",
  "DELETE /workspaces/{workspace_id}/clients/{client_id}": "delete_client",
  "DELETE /organizations/{organization_id}/groups/{group_id}": "delete_group",
  "DELETE /workspaces/{workspace_id}/project_groups/{project_group_id}": "delete_project_group",
  "DELETE /subscriptions/{workspace_id}/{subscription_id}": "delete_subscription",
  "POST /me/disable_weekly_report/{weekly_report_code}": "disable_weekly_report",
  "PATCH /workspaces/{workspace_id}/time_entries/{time_entry_ids}": "edit_time_entries",
  "GET /subscriptions/plans": "get_all_plans",
  "GET /workspaces/{workspace_id}/clients/{client_id}": "get_client_details",
  "GET /countries": "get_countries",
  "GET /countries/{country_id}/subdivisions": "get_country_subdivisions",
  "GET /currencies": "get_currencies",
  "GET /me/time_entries/current": "get_current_time_entry",
  "GET /event_filters": "get_event_filters",
  "GET /keys": "get_keys",
  "GET /workspaces/{workspace_id}/clients": "get_list_clients",
  "GET /me/location": "get_my_location",
  "GET /me/quota": "get_my_quota",
  "GET /organizations/{organization_id}": "get_organization_details",
  "GET /organizations/{organization_id}/groups": "get_organization_groups",
  "GET /organizations/{organization_id}/users": "get_organization_users",
  "GET /workspaces/{workspace_id}/projects/{project_id}": "get_project_details",
  "GET /workspaces/{workspace_id}/projects": "get_projects",
  "POST /reports/api/v3/workspace/{workspace_id}/projects/{project_id}/summary": "get_project_summary_report",
  "GET /workspaces/plans": "get_public_subscription_plans",
  "GET /status": "get_status",
  "GET /workspaces/{workspace_id}/tags": "get_tags",
  "GET /workspaces/{workspace_id}/tasks": "get_tasks",
  "GET /me/time_entries": "get_time_entries",
  "GET /me/time_entries/{time_entry_id}": "get_time_entry",
  "GET /timezones/offsets": "get_timezone_offsets",
  "GET /timezones": "get_timezones",
  "GET /me/clients": "get_user_clients",
  "GET /me/preferences": "get_user_preferences",
  "GET /me/projects": "get_user_projects",
  "GET /me/tags": "get_user_tags",
  "GET /me/tasks": "get_user_tasks",
  "GET /me/workspaces": "get_user_workspaces",
  "GET /workspaces/{workspace_id}": "get_workspace_details",
  "GET /workspaces/{workspace_id}/logo": "get_workspace_logo",
  "GET /workspaces/{workspace_id}/preferences": "get_workspace_preferences",
  "GET /workspaces/{workspace_id}/users": "get_workspace_users",
  "PATCH /workspaces/{workspace_id}/time_entries/{time_entry_id}/stop": "patch_stop_time_entry",
  "POST /me/disable_product_emails/{disable_code}": "post_me_disable_product_emails",
  "PUT /workspaces/{workspace_id}/tags/{tag_id}": "put_update_tag",
  "DELETE /workspaces/{workspace_id}/tags/{tag_id}": "delete_tag",
  "POST /reports/api/v3/workspace/{workspace_id}/search/time_entries": "search_detailed_report_time_entries",
  "POST /smail/demo": "send_demo_email",
  "POST /smail/contact": "send_email_contact",
  "POST /smail/meet": "send_smail_meet",
  "PUT /workspaces/{workspace_id}/clients/{client_id}": "update_client",
  "PUT /workspaces/{workspace_id}/projects/{project_id}": "update_project",
};
// plainer names for Toggl ids that are hard to read
const RENAME: Record<string, string> = {
  put_workspace_time_entry_handler: "update_time_entry",
  delete_workspace_time_entries: "delete_time_entry",
  get_workspace_project_tasks: "get_project_tasks",
  get_workspace_project_task: "get_task",
  post_workspace_project_tasks: "create_task",
  put_workspace_project_task: "update_task",
  patch_workspace_project_tasks: "edit_tasks",
  delete_workspace_project_task: "delete_task",
  delete_workspace_project: "delete_project",
  patch_workspace_projects: "edit_projects",
  get_projects_project_id_statistics: "get_project_statistics",
  post_projects_billable_amounts: "get_projects_billable_amounts",
  get_goals: "get_goals",
  post_goals: "create_goal",
  get_goals_goal_id: "get_goal",
  put_goals_goal_id: "update_goal",
  delete_goals_goal_id: "delete_goal",
  get_sync_server_me_goals: "get_my_goals",
  get_integrations_calendar: "get_calendar_integrations",
  get_integrations_calendar_calendars: "get_calendars",
  get_integrations_calendar_calendars_selected: "get_selected_calendars",
  get_integrations_calendar_events: "get_calendar_events",
  post_integrations_calendar_events_details_suggestion: "suggest_calendar_events_details",
  post_integrations_calendar_events_update: "refresh_calendar_events",
  get_integrations_calendar_events_event_id_details_suggestion: "suggest_calendar_event_details",
  get_integrations_calendar_setup: "get_calendar_integration_setup_url",
  put_integrations_calendar_integration_id: "update_calendar_integration",
  delete_integrations_calendar_integration_id: "delete_calendar_integration",
  get_integrations_calendar_integration_id_calendars: "get_calendar_integration_calendars",
  post_integrations_calendar_integration_id_calendars_update: "refresh_calendar_integration_calendars",
  patch_integrations_calendar_integration_id_calendars_calendar_id: "select_calendar",
  get_integrations_calendar_integration_id_calendars_calendar_id_events_event_id_attendees: "get_calendar_event_attendees",
  get_integrations_calendar_integration_id_calendars_id_calendar_events: "get_calendar_integration_events",
  post_subscription: "create_subscription",
  post_ping: "ping_subscription",
  get_validate: "validate_subscription",
  post_alerts: "create_alert",
  put_alerts: "update_alert",
  delete_alerts: "delete_alert",
};

// both the Track and the Webhooks API have GET /status; Track's is Composio's
const WEBHOOKS: Record<string, string> = { "GET /status": "get_webhooks_status" };

// Reports and Insights answers are reads, though every one is a POST: reports_summary_time_entries, insights_trends_projects_export
function name(id: string, method: string, path: string, op: Schema) {
  const known = (op["x-spec"] === "webhooks" ? WEBHOOKS[`${method} ${path}`] : undefined) ?? NAMES[`${method} ${path}`];
  if (known) return known;
  const snake = id.replace(/-/g, "_");
  if (op["x-spec"] === "reports") return snake.replace(/^post_/, "").replace(/_extension$/, "_export").replace(/_report_token/, "");
  return RENAME[snake] ?? snake;
}
const reports = Object.entries<Schema>((await Bun.file(specs[1]!).json()).paths).flatMap(([path, ops]) => Object.entries<Schema>(ops).map(([method, op]) => name(op.operationId.replace(/-/g, "_"), method.toUpperCase(), path, op)));

export default {
  spec: specs,
  out: "src/integrations/own/toggl/actions.json",
  name,
  rename: {},
  skip: {
    "get-saml2-login-url": "starts a browser single sign-on; a pasted API token has no use for it",
    "post-saml2-callback": "the identity provider's half of single sign-on, not something a person calls",
    "post-reset-token": "replaces the very API token Emplio signs in with, which would cut the connection",
  },
  // POSTs that only look things up or build a report
  reads: [
    ...reports,
    "get_workspace_clients_data",
    "post_favorites_suggestions",
    "post_workspace_favorites_suggestions",
    "get_projects_billable_amounts",
    "project_task_count",
    "project_user_count",
    "post_workspace_project_users_paginated",
    "get_workspace_tasks_data",
    "post_workspace_users_data",
    "get_workspace_timesheet_hours_handler",
    "post_import_preview_counts",
    "suggest_calendar_events_details",
    "get_feature_upsell_multi",
  ],
  // answers that carry a login or a webhook's signing secret
  secrets: ["get_desktop_login", "get_subscriptions"],
} satisfies AppConfig;

// Clockify: what the generator (../openapi-actions.ts) can't tell from the spec. One spec holds the main API, the
// reports API (reports.api.clockify.me) and the audit log; each operation names its own server.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const OUT = "src/integrations/own/clockify/actions.json";

export default {
  spec: "https://docs.clockify.me/openapi.json",
  out: OUT,
  name: namer(await composioNames("clockify")),
  // Composio's names for the same calls, so saved automations carry over
  rename: {
    get_currently_logged_in_user_s_info: "get_currently_logged_in_user_info",
    get_webhooks_for_addon_on_workspace: "get_all_addon_webhooks",
    get_webhooks_on_workspace: "get_all_webhooks",
    created_entities_experimental: "get_created_entities",
    deleted_entities_experimental: "get_deleted_entities",
    updated_entities_experimental: "get_updated_entities",
    find_user_s_team_manager: "find_user_team_manager",
    update_user_s_hourly_rate: "update_user_hourly_rate",
    update_project_user_s_billable_rate: "update_project_user_hourly_rate",
    update_workspace_billable_rate: "update_workspace_hourly_rate",
    stop_currently_running_timer_on_workspace_for_user: "stop_user_timer",
    bulk_edit_time_entries: "update_time_entries",
    delete_time_entries_for_user_on_workspace: "delete_user_time_entries",
    add_new_time_entry_for_another_user_on_workspace: "create_user_time_entry",
    get_assignments: "list_assignments",
    generate_shared_report_by_id: "get_shared_report",
    get_my_shared_reports: "get_shared_reports",
    generate_new_token: "generate_new_webhook_token",
  },
  // POSTs that only look things up: filters, totals and reports
  reads: [
    "filter_out_invoices",
    "get_scheduled_assignments_per_project",
    "get_total_of_users_capacity_on_workspace",
    "get_multiple_time_entries_on_workspace",
    "get_time_off_requests_on_workspace",
    "filter_workspace_users",
    "get_webhook_logs",
    "generate_attendance_report",
    "generate_detailed_report",
    "generate_expense_report",
    "generate_summary_report",
    "generate_weekly_report",
    "generate_audit_log_report",
  ],
  // answers carry each webhook's signing token
  secrets: ["get_all_webhooks", "get_all_addon_webhooks", "get_webhook_by_id"],
  // The spec gives nearly every field a default ("", null, false). zod would fill them in, and an update would then
  // blank whatever the agent left out, so they go: only what the agent gives is sent.
  after: async () => {
    const file = new URL(`../../${OUT}`, import.meta.url).pathname;
    const out = await Bun.file(file).json();
    const strip = (s: unknown): void => {
      if (Array.isArray(s)) return s.forEach(strip);
      if (!s || typeof s !== "object") return;
      delete (s as Record<string, unknown>).default;
      Object.values(s).forEach(strip);
    };
    for (const a of out.actions) strip(a.input);
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;

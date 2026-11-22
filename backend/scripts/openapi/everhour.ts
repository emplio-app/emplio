// Everhour: what the generator (../openapi-actions.ts) can't tell from the spec. Everhour publishes an OpenAPI 3 spec with
// its Mintlify docs (developers.everhour.com/openapi.json); every call is on api.everhour.com with the X-Api-Key header.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const OUT = "src/integrations/own/everhour/actions.json";

// what an id looks like and where to find it, for the agent
const ID = {
  user: "The person's Everhour user id, a number (list_team_members lists the team; get_user_profile is you)",
  project: "The project's id, like ev:1234567890 (Everhour's own) or as:1234 / tr:abcd for one synced from Asana, Trello and so on; list_projects shows them",
  task: "The task's id, like ev:1234567890 or as:1234 for a synced one; list_project_tasks or search_tasks show them",
  client: "The client's id, a number (client_list shows them)",
  date: "A day, as YYYY-MM-DD",
};

export default {
  spec: "https://developers.everhour.com/openapi.json",
  out: OUT,
  name: namer(await composioNames("everhour")),
  // Composio's names for the same calls, so skills and automations made on Composio carry over; plainer names for the rest
  rename: {
    get_clients: "client_list",
    delete_webhook: "delete_hook",
    discard_approval_request: "discard_timesheet_approval",
    get_expenses: "expenses_list",
    get_running_timer: "get_current_timer",
    projects_report: "get_projects_report",
    get_current_user: "get_user_profile",
    get_categories: "list_expense_categories",
    get_webhooks: "list_hooks",
    get_invoices: "list_invoices",
    get_projects: "list_projects",
    get_project_tasks: "list_project_tasks",
    get_project_time_records: "list_project_time_records",
    get_project_sections: "list_sections",
    get_users: "list_team_members",
    get_time_records: "list_team_time_records",
    get_timecards: "list_timecards",
    get_user_timecards: "list_user_timecards",
    get_user_timesheets: "list_user_timesheets",
    approve_week_request_for_approval: "request_timesheet_approval",
    approve_or_reject_approval_request: "review_timesheet_approval",
    get_team_timesheets: "list_team_timesheets",
    get_team_timers: "list_team_timers",
    create_category: "create_expense_category",
    update_category: "update_expense_category",
    delete_category: "delete_expense_category",
    export_invoice_to_xero_qb_fb: "export_invoice",
    clients_report: "get_clients_report",
    users_report: "get_users_report",
    get_assignments: "list_schedule_assignments",
    create_assignment: "create_schedule_assignment",
    update_assignment: "update_schedule_assignment",
    delete_assignment: "delete_schedule_assignment",
    get_allocations: "list_time_off_allocations",
    create_allocation: "create_time_off_allocation",
    update_allocation: "update_time_off_allocation",
    delete_allocation: "delete_time_off_allocation",
    get_project_fields_configuration: "list_project_custom_fields",
    create_field_in_project: "create_custom_field",
    update_field: "update_custom_field",
    delete_field: "delete_custom_field",
    reorder_fields: "reorder_custom_fields",
  },
  skip: {
    estimatesReportDeprecated: "Everhour marks it deprecated; get_projects_report and list_project_tasks (estimates) replace it",
    timeReportDeprecated: "Everhour marks it deprecated; list_team_time_records and the dashboards reports replace it",
  },
  // list_hooks and get_webhook show our webhook's address, whose last part is what proves a delivery is Everhour's
  secrets: ["list_hooks", "get_webhook"],
  params: {
    user_id: ID.user,
    project_id: ID.project,
    task_id: ID.task,
    client_id: ID.client,
    date: ID.date,
    from: "From this day, as YYYY-MM-DD",
    to: "Up to this day, as YYYY-MM-DD",
    project: "Only this project (its id, like ev:1234567890)",
    weekId: "One week, as YYWW: 2647 is the 47th week of 2026",
    section_id: "The section's id, a number (list_sections shows a project's sections)",
    time_id: "The time record's id, a number (the time record lists show them)",
    expense_id: "The expense's id, a number (expenses_list shows them)",
    invoice_id: "The invoice's id, a number (list_invoices shows them)",
    timesheet_id: "The timesheet's id, a number (list_team_timesheets or list_user_timesheets show them)",
    hook_id: "The webhook's id, a number (list_hooks shows them)",
    attachment_token: "The attachment's token, from the expense's attachments list",
  },
  // the spec leaves some body fields with no description, or just "Task ID"; say what they take
  after: async () => {
    const file = new URL(`../../${OUT}`, import.meta.url).pathname;
    const out = await Bun.file(file).json();
    const BODY: Record<string, string> = {
      date: ID.date,
      user: ID.user,
      task: ID.task,
      time: "Time in seconds (1 hour = 3600)",
      startDate: ID.date,
      endDate: ID.date,
      name: "Its name",
      comment: "A note on the time",
    };
    for (const a of out.actions)
      for (const [k, s] of Object.entries<Record<string, unknown>>(a.input.properties ?? {}))
        if (BODY[k] && String(s.description ?? "").length < 12) s.description = BODY[k];
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;

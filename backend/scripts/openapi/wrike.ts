// Wrike: what the generator (../openapi-actions.ts) can't tell from the spec. Wrike's own OpenAPI file, as its ReadMe
// docs (developers.wrike.com) serve it; the id after api-registry changes when they publish a new version.
// Every param is in the query, and most lists and objects are "content: application/json" params with no schema, which
// the generator would leave untyped: they get their schema here, and own/wrike/index.ts sends them as JSON text.
// Writes take their params as a form body instead of the query, so long descriptions and comments fit.
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";

const SPEC = "https://dash.readme.com/api/v1/api-registry/d2p4bhmuzfjvff";
const OUT = "src/integrations/own/wrike/actions.json";
type Schema = Record<string, any>;

const spec = (await (await fetch(SPEC)).json()) as Schema;
// "METHOD /path" → its params sent as JSON text
const asJson = new Map<string, string[]>();
for (const [path, ops] of Object.entries<Schema>(spec.paths))
  for (const [method, op] of Object.entries<Schema>(ops)) {
    const json: string[] = [];
    for (const p of op.parameters ?? []) {
      const s = p.content?.["application/json"]?.schema;
      if (!s || p.schema) continue;
      p.schema = s;
      delete p.content;
      json.push(p.name);
    }
    if (json.length) asJson.set(`${method.toUpperCase()} ${path}`, json);
  }
const local = `${tmpdir()}/wrike-openapi.json`;
await Bun.write(local, JSON.stringify(spec));

// Composio's names for the same calls, so automations written for it carry over; the rest are named from the path
// (GET /tasks/{taskId}/comments → get_tasks_comments), the way most of Composio's Wrike names are
const NAMES: Record<string, string> = {
  "PUT /groups_bulk": "bulk_modify_groups",
  "POST /copy_folder/{folderId}": "copy_folder",
  "POST /copy_folder_async/{folderId}": "copy_folder_async",
  "POST /customfields": "create_customfield",
  "POST /folders/{folderId}/folders": "create_folder",
  "POST /folders/{folderId}/bookings": "create_folder_booking",
  "POST /folders/{folderId}/timelog_lock_periods": "create_folders_timelog_lock_period",
  "POST /groups": "create_group",
  "POST /invitations": "create_invitation",
  "POST /spaces/{spaceId}/timelog_lock_periods": "create_spaces_timelog_lock_period",
  "POST /folders/{folderId}/tasks": "create_task",
  "POST /tasks/{taskId}/attachments": "create_task_attachment",
  "POST /folders/{folderId}/attachments": "create_folder_attachment",
  "POST /tasks/{taskId}/comments": "create_task_comment",
  "GET /comments/{commentId}/comments": "get_comment_replies",
  "POST /comments/{commentId}/comments": "create_comment_reply",
  "DELETE /approvals/{approvalId}": "delete_approvals",
  "DELETE /assets/{assetId}": "delete_asset",
  "DELETE /attachments/{attachmentId}": "delete_attachments",
  "DELETE /bookings/{bookingId}": "delete_booking",
  "DELETE /comments/{commentId}": "delete_comment",
  "DELETE /dependencies/{dependencyId}": "delete_dependencies",
  "DELETE /folders/{folderId}": "delete_folder",
  "DELETE /folders/{folderId}/timelog_lock_periods": "delete_folders_timelog_lock_period",
  "DELETE /groups/{groupId}": "delete_group",
  // Composio spells it delete_inivtation
  "DELETE /invitations/{invitationId}": "delete_invitation",
  "DELETE /jobroles/{jobroleId}": "delete_job_role",
  "DELETE /spaces/{spaceId}": "delete_space",
  "DELETE /spaces/{spaceId}/timelog_lock_periods": "delete_spaces_timelog",
  "DELETE /tasks/{taskId}": "delete_task",
  "DELETE /timelogs/{timelogId}": "delete_timelog",
  "GET /tasks": "fetch_all_tasks",
  "GET /account": "get_account_information",
  "GET /customfields": "get_all_custom_fields",
  "GET /async_job/{asyncJobId}": "get_async_job",
  "GET /contacts/{contactIds}/hourly_rates": "get_contact_hourly_rates",
  "GET /contacts/{contactIds}/contacts_history": "get_contacts_history",
  "GET /contacts/{contactId}/timelogs": "get_contact_timelogs",
  "GET /dependencies/{dependencyIds}": "get_dependencies",
  "GET /folders/{folderId}/bookings": "get_folder_bookings",
  "GET /folders/{folderIds}/folders_history": "get_folders_history",
  "GET /folders/{folderId}/hourly_rates": "get_folders_hourly",
  "GET /contacts/{contactIds}": "get_information_about_specific_contact",
  "GET /jobroles/{jobroleIds}": "get_job_roles",
  "GET /placeholders/{placeholderIds}/hourly_rates": "get_placeholder_hourly_rates",
  "GET /placeholders/{placeholderIds}": "get_placeholders",
  "GET /spaces/{spaceId}": "get_space",
  "GET /spaces/{spaceId}/custom_item_types": "get_space_custom_item_types",
  "GET /spaces/{spaceId}/folders": "get_space_folders",
  "GET /spaces/{spaceId}/timelog_lock_periods": "get_space_timelog_lock_periods",
  "GET /users/{userId}": "get_specific_user",
  "GET /tasks/{taskIds}": "get_task_by_id",
  "GET /tasks/{taskId}/dependencies": "get_task_dependencies",
  "GET /tasks/{taskIds}/tasks_history": "get_tasks_history",
  "GET /tasks/{taskId}/timelogs": "get_task_timelogs",
  "GET /workschedules/{workscheduleId}/timesheet_submission_rules": "get_workschedules_timesheet",
  "POST /folder_blueprints/{folderBlueprintId}/launch_async": "launch_folder_blueprint_async",
  "POST /task_blueprints/{taskBlueprintId}/launch_async": "launch_task_blueprint_async",
  "GET /attachments": "list_attachments",
  "GET /attachments/{attachmentIds}": "get_attachments",
  "GET /folder_blueprints": "list_folder_blueprints",
  "GET /placeholders": "list_placeholders",
  "GET /spaces/{spaceId}/folder_blueprints": "list_space_folder_blueprints",
  "GET /spaces": "list_spaces",
  "GET /spaces/{spaceId}/task_blueprints": "list_space_task_blueprints",
  "GET /folders/{folderId}/folders": "list_subfolders_by_folder_id",
  "GET /task_blueprints": "list_task_blueprints",
  "PUT /account": "modify_account",
  "PUT /folders/{folderId}": "modify_folder",
  "PUT /groups/{groupId}": "modify_group",
  "PUT /tasks/{taskId}": "modify_task",
  "PUT /folders/{folderIds}": "update_folders_bulk",
  "PUT /tasks/{taskIds}": "update_tasks_bulk",
  "PUT /users/{userIds}": "update_users_bulk",
  "GET /customfields/{customfieldIds}": "query_customfields",
  "GET /invitations": "query_invitations",
  "GET /jobroles": "query_job_roles",
  "GET /groups/{groupId}": "query_specific_group",
  "GET /workflows": "query_workflows",
  "GET /groups": "retrieve_list_of_groups",
  "POST /ediscovery_search": "search_ediscovery",
  "PUT /approvals/{approvalId}": "update_approvals",
  "PUT /assets/{assetId}": "update_asset",
  "PUT /attachments/{attachmentId}": "update_attachment",
  "PUT /bookings/{bookingId}": "update_bookings",
  "PUT /comments/{commentId}": "update_comment",
  "PUT /customfields/{customfieldId}": "update_custom_field_by_id",
  "PUT /dependencies/{dependencyId}": "update_dependency",
  "PUT /invitations/{invitationId}": "update_invitation",
  "PUT /jobroles/{jobroleId}": "update_job_role",
  "PUT /contacts/{contactId}": "update_metadata_on_specific_contact",
  "PUT /users/{userId}": "update_specific_user",
  "PUT /timelogs/{timelogId}": "update_timelogs",
  "PUT /timesheet_rows/{timesheetRowId}": "update_timesheet_row",
  "PUT /timesheets/{timesheetId}": "update_timesheets",
  "PUT /workflows/{workflowId}": "update_workflow",
  "PUT /workschedules/{workscheduleId}/timesheet_submission_rules": "update_workschedule_timesheet_rules",
};
const VERB: Record<string, string> = { GET: "get", POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const pathName = (method: string, path: string) => {
  const parts = path.split("/").filter(Boolean);
  const last = /^\{(\w+)\}$/.exec(parts.at(-1) ?? "")?.[1];
  const words = parts.filter((p) => !p.startsWith("{")).map(snake);
  return [VERB[method], ...words].join("_") + (last ? (last.endsWith("Ids") ? "_by_ids" : "_by_id") : "");
};

// path ids the spec leaves undescribed: where to find them
const IDS: Record<string, string> = {
  folderId: "The folder's or project's id (get_folders lists them; the account's top level is rootFolderId from get_account_information)",
  taskId: "The task's id (fetch_all_tasks or get_folders_tasks lists them)",
  spaceId: "The space's id (list_spaces lists them)",
  userId: "The user's id (get_contacts lists people with their ids)",
  contactId: "The person's id (get_contacts lists them)",
  commentId: "The comment's id (get_tasks_comments lists a task's comments)",
  attachmentId: "The attachment's id (get_tasks_attachments lists a task's files)",
  timelogId: "The time entry's id (get_task_timelogs lists a task's time entries)",
  workflowId: "The workflow's id (query_workflows lists them)",
  customfieldId: "The custom field's id (get_all_custom_fields lists them)",
  groupId: "The group's id (retrieve_list_of_groups lists them)",
};
const words = (name: string) => snake(name.replace(/Ids?$/, "")).replace(/_/g, " ").replace(/^customfield$/, "custom field").replace(/^jobrole$/, "job role").replace(/^workschedule/, "work schedule");

export default {
  spec: local,
  out: OUT,
  name: (_id, method, path) => NAMES[`${method} ${path}`] ?? pathName(method, path),
  // a search that changes nothing
  reads: ["search_ediscovery"],
  after: async () => {
    const file = new URL(`../../${OUT}`, import.meta.url).pathname;
    const out = await Bun.file(file).json();
    for (const a of out.actions) {
      for (const [k, v] of Object.entries<Schema>(a.input.properties))
        if (!v.description) v.description = IDS[k] ?? `The ${words(k)}'s id`;
      const json = asJson.get(`${a.send.method} ${a.send.path}`);
      if (json) a.json = json;
      if (!["POST", "PUT", "PATCH"].includes(a.send.method) || !a.send.query.length) continue;
      a.send.body = { kind: "urlencoded", fields: a.send.query.map((q: string) => [q, q]) };
      a.send.query = [];
    }
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;

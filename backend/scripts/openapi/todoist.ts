// Todoist: what the generator (../openapi-actions.ts) can't tell from the spec. Todoist publishes it only inside its docs
// page (the __redoc_state object in https://developer.todoist.com/api/v1/): save that object's spec.data and pass the file.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

export default {
  spec: "todoist-spec.json",
  out: "src/integrations/own/todoist/actions.json",
  name: namer(await composioNames("todoist")),
  rename: {
    get_labels: "list_labels",
    get_sections: "list_sections",
    get_project_collaborators: "list_project_collaborators",
    get_activity_logs: "list_activities",
    user_info: "get_user",
    tasks_completed_by_completion_date: "get_completed_tasks_by_completion_date",
    tasks_completed_by_due_date: "list_completed_tasks_by_due_date",
    get_tasks_by_filter: "filter_tasks",
    quick_add: "quick_add_task",
  },
  // these cancel the very token the action runs on, or the account's paid plan
  skip: (_method, path) => (/\/(access_tokens|revoke|cancel_plan|reactivate_plan|migrate_personal_token)/.test(path) ? "ends the login or changes the Todoist plan; for the person to do in Todoist" : undefined),
} satisfies AppConfig;

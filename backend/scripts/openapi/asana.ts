// Asana: what the generator (../openapi-actions.ts) can't tell from the spec.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const OUT = "src/integrations/own/asana/actions.json";
type Schema = Record<string, any>;

export default {
  spec: "https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml",
  out: OUT,
  name: namer(await composioNames("asana")),
  // pretty-printing only makes the answer longer
  drop: { "*": ["opt_pretty"] },
  rename: {
    add_users_to_project: "add_members_to_project",
    set_dependencies_for_task: "add_task_dependencies",
    add_user_to_workspace_or_organization: "add_user_to_workspace",
    create_story_on_task: "create_task_comment",
    get_project_s_custom_fields: "get_project_custom_field_settings",
    get_statuses_from_project: "get_project_status_updates",
    get_status_updates_from_object: "get_status_updates",
    get_attachments_from_object: "get_task_attachments",
    get_objects_via_typeahead: "get_typeahead_objects",
    instantiate_project_from_project_template: "instantiate_project_template",
    get_dependencies_from_task: "list_task_dependencies",
    get_dependents_from_task: "list_task_dependents",
    unlink_dependencies_from_task: "remove_task_dependencies",
  },
  // Every Asana body is {"data": {...}}, and an agent only sees an action's top-level fields. So the fields inside
  // `data` become the action's own, listed in `data` for own/asana/index.ts to put back when it sends them.
  after: async (spec) => {
    const resolve = (s: Schema): Schema => (s?.$ref ? resolve((s.$ref as string).slice(2).split("/").reduce((o: Schema, k) => o[k], spec)) : s);
    const answers = (s: Schema): string[] => [
      ...(resolve(s).allOf ?? []).flatMap(answers),
      ...Object.entries<Schema>(resolve(s).properties ?? {}).filter(([, v]) => resolve(v).readOnly).map(([k]) => k),
    ];
    const file = new URL(`../../${OUT}`, import.meta.url).pathname;
    const out = await Bun.file(file).json();
    for (const a of out.actions) {
      // one enum of every field per call is most of the file, and an agent isn't shown it
      delete a.input.properties.opt_fields?.items?.enum;
      if (a.input.properties.opt_fields) a.input.properties.opt_fields.description = "Fields to add to the answer, like [\"name\", \"assignee.name\", \"due_on\"]. Lists otherwise give only a few fields.";
      const inner = a.input.properties.data;
      if (a.send.body?.kind !== "fields" || !inner?.properties) continue;
      delete a.input.properties.data;
      const op = spec.paths[a.send.path][a.send.method.toLowerCase()];
      const skip = answers(resolve(op.requestBody.content["application/json"].schema).properties.data);
      const fields: [string, string][] = [];
      for (const [k, v] of Object.entries<Schema>(inner.properties)) {
        if (skip.includes(k)) continue;
        const field = k in a.input.properties ? `body_${k}` : k;
        a.input.properties[field] = v;
        fields.push([field, k]);
        if (inner.required?.includes(k)) (a.input.required ??= []).push(field);
      }
      a.data = fields;
    }
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;

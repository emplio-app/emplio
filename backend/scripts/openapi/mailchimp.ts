// Mailchimp (Marketing API): what the generator (../openapi-actions.ts) can't tell from the spec. Mailchimp publishes a
// Swagger 2 file in mailchimp/mailchimp-client-lib-codegen; it's lifted to OpenAPI 3 here and written to a temp file
// the generator then reads. The Transactional (Mandrill) API is a separate product with its own key: not part of this app.
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

type Schema = Record<string, any>;
const SPEC = "https://raw.githubusercontent.com/mailchimp/mailchimp-client-lib-codegen/main/spec/marketing.json";
const METHODS = ["get", "post", "put", "patch", "delete"];

// Swagger 2 → OpenAPI 3, as far as this file needs: the body param becomes a requestBody, the rest get a schema,
// and comma-separated arrays (fields, exclude_fields) are sent comma separated
function lift(s: Schema): Schema {
  s = JSON.parse(JSON.stringify(s).replaceAll('"#/definitions/', '"#/components/schemas/'));
  for (const ops of Object.values<Schema>(s.paths)) {
    for (const [m, op] of Object.entries<Schema>(ops)) {
      if (!METHODS.includes(m)) continue;
      const params = (op.parameters ?? []).map((p: Schema) => {
        const { name, in: where, required, description, schema, collectionFormat, ...rest } = p;
        if (where === "body") return p;
        return {
          name,
          in: where,
          required,
          description,
          ...(collectionFormat === "csv" && { explode: false }),
          schema: { type: rest.type, items: rest.items, enum: rest.enum, default: rest.default, minimum: rest.minimum, maximum: rest.maximum },
        };
      });
      const body = params.find((p: Schema) => p.in === "body");
      if (body) op.requestBody = { required: body.required, content: { "application/json": { schema: { ...body.schema, description: body.description } } } };
      op.parameters = params.filter((p: Schema) => p.in !== "body");
    }
  }
  return { openapi: "3.0.0", paths: s.paths, components: { schemas: s.definitions ?? {} } };
}

const file = `${tmpdir()}/emplio-mailchimp-marketing.json`;
await Bun.write(file, JSON.stringify(lift(await (await fetch(SPEC)).json())));

export default {
  spec: file,
  out: "src/integrations/own/mailchimp/actions.json",
  // Composio's names where they mean the same call, so saved skills and automations carry over
  name: namer(await composioNames("mailchimp")),
  // the rest of Composio's names, which the summaries don't give
  rename: {
    add_contact: "add_contact_to_audience",
    get_contacts: "get_audiences_contacts",
    get_contact: "get_audiences_contacts_detail",
    update_contact: "update_audiences_contacts",
    get_reports_id_abuse_reports_id: "retrieve_campaign_abuse_complaints",
    get_reports_id_abuse_reports_id_id: "campaign_abuse_report_details",
    get_reports_id_advice: "campaign_statistics_feedback",
    list_campaign_details: "list_campaign_click_details",
    get_file_manager_folders_files: "retrieve_folder_contents",
    update_segment: "update_lists_segments",
    add_or_update_order: "upsert_ecommerce_stores_orders",
    create_or_update_product: "upsert_ecommerce_stores_products",
    view_recent_activity_50: "view_recent_activity50",
  },
  // only checks whether the site's script is in place
  reads: ["verify_connected_site_script"],
  params: {
    list_id: "The audience's id (Mailchimp calls audiences lists). get_lists_info lists them with their ids.",
    subscriber_hash: "The contact's email address, or the MD5 hash of it in lower case. An email works: Emplio hashes it.",
    fields: "Only these fields of the answer, comma separated in dot notation (like members.email_address). Leave out for all.",
    exclude_fields: "Leave these fields out of the answer, comma separated in dot notation. Useful to keep long answers short (like _links).",
    count: "How many to return (default 10, at most 1000).",
    offset: "How many to skip, to page through results.",
  },
} satisfies AppConfig;

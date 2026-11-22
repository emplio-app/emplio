// Dropbox Sign: what the generator (../openapi-actions.ts) can't tell from the spec.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const OUT = "src/integrations/own/dropbox_sign/actions.json";
type Schema = Record<string, any>;

export default {
  spec: "https://raw.githubusercontent.com/hellosign/hellosign-openapi/main/openapi.yaml",
  out: OUT,
  name: namer(await composioNames("dropbox_sign")),
  // Composio's names for the same calls, so saved skills and automations carry over
  rename: {
    embedded_bulk_send_with_template: "bulk_create_embedded_sig_req_with_template",
    cancel_incomplete_signature_request: "cancel_signature_request",
    download_files: "download_signature_request_files",
    download_files_as_data_uri: "get_signature_request_files_as_data_uri",
    download_files_as_file_url: "get_signature_request_files_as_file_url",
    edit_embedded_signature_request: "edit_and_resend_embedded_signature_request",
    edit_embedded_signature_request_with_template: "edit_resend_embedded_signature_request_template",
    update_signature_request: "edit_and_resend_signature_request",
    signature_request_update: "update_signature_request",
    edit_signature_request_with_template: "edit_and_resend_signature_request_with_template",
    get_team: "get_current_team",
    get_available_fax_line_area_codes: "get_fax_line_area_codes",
    lists_faxes: "list_faxes",
    send_request_reminder: "send_signature_request_reminder",
  },
  // API apps come back with their OAuth secret
  secrets: ["get_api_app", "list_api_apps"],
  skip: {
    oauthTokenGenerate: "OAuth sign-in plumbing (trading a code for a token); Emplio signs in with an API key",
    oauthTokenRefresh: "OAuth sign-in plumbing (renewing a token); Emplio signs in with an API key",
  },
  // Calls that take documents accept JSON or multipart; the generator picks JSON, where a file can't go. Which of
  // their fields are files is noted as `files`, for own/dropbox_sign/index.ts to send those calls as multipart when one is given.
  after: async (spec) => {
    const resolve = (s: Schema): Schema => (s?.$ref ? resolve((s.$ref as string).slice(2).split("/").reduce((o: Schema, k) => o[k], spec)) : s);
    const isFile = (s: Schema): boolean => {
      const r = resolve(s ?? {});
      return r.format === "binary" || (r.type === "array" && isFile(r.items));
    };
    const file = new URL(`../../${OUT}`, import.meta.url).pathname;
    const out = await Bun.file(file).json();
    for (const a of out.actions) {
      const op = spec.paths[a.send.path]?.[a.send.method.toLowerCase()];
      const schema = op?.requestBody?.content?.["multipart/form-data"]?.schema;
      if (!schema || a.send.body?.kind !== "fields") continue;
      const files = Object.entries<Schema>(resolve(schema).properties ?? {}).filter(([, v]) => isFile(v)).map(([k]) => k);
      for (const k of files) {
        const many = resolve(resolve(schema).properties[k]).type === "array";
        const desc = (resolve(resolve(schema).properties[k]).description ?? "").trim();
        a.input.properties[k] = many
          ? { type: "array", items: {}, description: `${desc} One or more files from the computer: [{"file": "/work/..."}]`.trim() }
          : { description: `${desc} A file from the computer: {"file": "/work/..."}`.trim() };
      }
      if (files.length) a.files = files;
    }
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;

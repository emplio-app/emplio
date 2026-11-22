// PandaDoc: what the generator (../openapi-actions.ts) can't tell from the spec.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const OUT = "src/integrations/own/pandadoc/actions.json";

export default {
  spec: "https://raw.githubusercontent.com/PandaDoc/pandadoc-openapi-specification/main/openapi.json",
  out: OUT,
  name: namer(await composioNames("pandadoc")),
  rename: {
    // Composio's names, so saved skills and automations carry over
    update_document_ownership: "change_document_ownership",
    create_document_from_file_upload: "create_document_from_file",
    create_document_section_from_file_upload: "create_document_section_from_upload",
    create_document_session_for_embedded_sign: "create_embedded_signing_session",
    create_documents_folder: "create_folder",
    create_contact: "create_or_update_contact",
    create_catalog_item: "create_product_catalog_item",
    create_webhook_subscription: "create_webhook",
    delete_catalog_item: "delete_product_catalog_item",
    api_log_details: "get_api_log_details",
    document_attachment_details: "get_attachment_details",
    document_auto_reminder_settings: "get_automatic_reminder_settings",
    document_auto_reminder_status: "get_automatic_reminder_status",
    contact_details: "get_contact_details",
    content_library_item_details: "get_content_library_item_details",
    content_library_item_status: "get_content_library_item_status",
    current_member_details: "get_current_member",
    document_details: "get_document_details",
    document_e_sign_disclosure: "get_document_e_sign_disclosure",
    document_section_details: "get_document_section_details",
    document_status: "get_document_status",
    member_details: "get_member_details",
    notarization_request_details: "get_notarization_request_details",
    catalog_item_details: "get_product_catalog_item",
    document_section_upload_status: "get_section_upload_status",
    template_details: "get_template_details",
    template_status: "get_template_status",
    get_user_details_by_id: "get_user_by_id",
    webhook_event_details: "get_webhook_event_details",
    webhook_subscription_details: "get_webhook_subscription_details",
    list_api_log: "list_api_logs",
    list_members: "list_workspace_members",
    change_signer_reassign_document_recipient: "reassign_document_signer",
    update_document_auto_reminder_settings: "update_automatic_reminder_settings",
    update_document_fields_assignment: "update_document_field_assignments",
    quote_update: "update_document_quote",
    update_catalog_item: "update_product_catalog_item",
    // the rest: plain names instead of the spec's summaries ("[Beta] ...")
    beta_get_submit_for_approval_configuration: "get_template_approval_workflow",
    beta_update_template_approval_workflow: "update_template_approval_workflow",
    beta_workspace_privacy_settings_details: "get_workspace_privacy_settings",
    beta_update_workspace_privacy_settings: "update_workspace_privacy_settings",
    beta_update_multiple_quotes: "update_document_quotes",
    beta_create_docx_export_task: "create_docx_export_task",
    beta_docx_export_task: "get_docx_export_task",
    beta_document_summary: "get_document_summary",
    beta_document_content: "get_document_content",
    beta_get_ai_metadata_for_document: "get_document_ai_metadata",
    beta_get_ai_metadata_for_multiple_documents: "get_documents_ai_metadata",
    beta_list_documents_search: "search_documents",
    beta_update_workspace: "update_workspace",
    create_document_from_markdown_file_upload: "create_document_from_markdown_file",
    create_template_from_file_upload: "create_template_from_file",
    add_dsv_named_items_to_document: "add_named_items_to_document",
  },
  // POSTs that only look things up
  reads: ["get_documents_ai_metadata"],
  // webhook subscriptions come back with their shared signing key
  secrets: ["list_webhook_subscriptions", "get_webhook_subscription_details"],
  skip: {
    accessToken: "OAuth sign-in plumbing (trading a code for a token), not something to do in PandaDoc; Emplio signs in with an API key",
  },
  // the attachment upload's form is an allOf the generator reads as empty: its two fields, by hand
  after: async () => {
    const file = new URL(`../../${OUT}`, import.meta.url).pathname;
    const out = await Bun.file(file).json();
    const a = out.actions.find((x: { name: string }) => x.name === "create_document_attachment_from_upload");
    a.input.properties.file = { description: 'The file to attach to the document. A file from the computer: {"file": "/work/..."}' };
    a.input.properties.name = { type: "string", description: "A name to show for the attachment, like \"Additional agreement\"" };
    a.input.required = [...a.input.required, "file"];
    a.send.body = { kind: "form", fields: [["file", "file"], ["name", "name"]] };
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;

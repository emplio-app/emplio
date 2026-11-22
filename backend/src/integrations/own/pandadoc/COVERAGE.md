# PandaDoc coverage

Source: PandaDoc's OpenAPI spec (github.com/PandaDoc/pandadoc-openapi-specification: openapi.json, pushed 2026-11-20),
generated 2026-11-22 by `bun scripts/openapi-actions.ts pandadoc`. Every operation is an action (133), plus one alias.

## Deliberately left out

| What | Why |
| --- | --- |
| POST /oauth2/access_token | OAuth sign-in plumbing (trading a code for a token), not something to do in PandaDoc |
| GET /public/v1/logs, GET /public/v1/logs/{id} | Marked deprecated; list_api_logs and get_api_log_details (v2) replace them |

Nothing Composio has is missing. Its names are kept (`namer`, `rename` in scripts/openapi/pandadoc.ts); its second
name for the catalog search, `search_product_catalog_items`, is an alias of `search_catalog_items` in index.ts. The
spec's "[Beta] ..." operations get plain names (get_document_summary, search_documents, ...).

## Hand adjustments (scripts/openapi/pandadoc.ts, own/pandadoc/index.ts)

- Uploads are told apart by a bare flag in the path (`/documents?upload`, `?upload-markdown`). index.ts moves the flag
  into the query, sent as `upload=`, so it can sit next to the other query fields (`editor_ver`, `fields`...).
- `create_document_attachment_from_upload`: its form is an allOf the generator reads as empty; `after` writes its two
  fields (file, name).
- Downloads come back as files named `<id>.pdf` (or the type's extension) instead of "download".
- `list_webhook_subscriptions` and `get_webhook_subscription_details` show each subscription's shared signing key, so
  they ask first. `get_documents_ai_metadata` is a POST that only reads, so it doesn't.

## Auth

| Method | Status |
| --- | --- |
| API key (Settings → Integrations → API), `Authorization: API-Key <key>` | done. Live keys need an Enterprise/API plan; a sandbox key works for testing |
| OAuth (read write) | not in this job (key sign-in only) |

## Triggers

One webhook subscription per connection (PandaDoc's webhooks are per workspace, and a key belongs to one workspace), at
`/webhooks/app/pandadoc/<connection>/events/<token>`, carrying the events its automations need, with every optional
payload part (metadata, fields, products, tokens, pricing). Found by URL; a new event is PATCHed in; one PandaDoc switched
off is switched back on; the last automation deletes it.

PandaDoc picks the shared key and sends the HMAC signature as a `?signature=` query parameter, which our shared
webhook route doesn't pass to apps, so the URL holds an HMAC token instead (see the `ponytail:` note in triggers.ts).
Delivery id: the `X-PandaDoc-Webhook-Event-Id` header plus the event's place in the array.

| Trigger | Settings |
| --- | --- |
| document_state_changed | status (e.g. document.completed), template_id, document_id |
| recipient_completed | recipient_email, template_id, document_id |
| document_completed_pdf_ready | template_id, document_id |
| document_updated | template_id, document_id |
| document_deleted | template_id, document_id |
| document_creation_failed | document_id |
| document_section_added | document_id |
| quote_updated | template_id, document_id |
| recipient_qes_verified | template_id, document_id |
| template_created | |
| template_updated | template_id |
| template_deleted | template_id |
| content_library_item_created | |
| content_library_item_creation_failed | |

Composio has no PandaDoc triggers; these are PandaDoc's own event names. Nothing is polled (polls/pandadoc.ts is empty).

Not tried live. No real account or key was used.

## Actions by group (* asks first)

**Documents** (29): list_documents, create_document*, bulk_delete_documents*, create_document_from_file*, create_document_from_markdown_file*, get_document_status, delete_document*, update_document*, get_document_e_sign_disclosure, change_document_status*, change_document_status_with_upload*, move_document_to_draft*, get_document_details, send_document*, create_document_editing_session*, create_embedded_signing_session*, download_document, download_completed_document, change_document_ownership*, transfer_ownership_of_documents*, move_document_to_folder*, append_content_library_item_to_document*, create_docx_export_task*, get_docx_export_task, get_document_summary, get_document_content, get_document_ai_metadata, get_documents_ai_metadata, search_documents

**Document Reminders** (4): update_automatic_reminder_settings*, get_automatic_reminder_settings, get_automatic_reminder_status, send_manual_reminder*

**Document Link to CRM** (5): list_documents_by_linked_object, list_linked_objects, create_linked_object*, delete_linked_object*, refresh_document_from_linked_object*

**Document Attachments** (6): list_document_attachments, create_document_attachment*, create_document_attachment_from_upload*, get_attachment_details, delete_document_attachment*, download_document_attachment

**Document Fields** (3): list_document_fields, update_document_field_assignments*, create_document_fields*

**Document Audit Trail** (1): list_document_audit_trail

**Document Settings** (2): get_document_settings, update_document_settings*

**Document Recipients** (4): add_document_recipient*, delete_document_recipient*, update_document_recipient*, reassign_document_signer*

**Document Sections (Bundles)** (6): list_document_sections, create_document_section*, create_document_section_from_upload*, get_section_upload_status, get_document_section_details, delete_document_section*

**Document Structure View** (1): add_named_items_to_document*

**Content Library Items** (5): list_content_library_items, create_content_library_item*, create_content_library_item_from_upload*, get_content_library_item_status, get_content_library_item_details

**Templates** (9): list_templates, create_template*, create_template_from_file*, duplicate_template*, get_template_details, delete_template*, get_template_status, update_template*, create_template_editing_session*

**Template Settings** (4): get_template_settings, update_template_settings*, get_template_sharing_settings, update_template_sharing_settings*

**Forms** (1): list_forms

**Folders** (6): list_document_folders, create_folder*, rename_document_folder*, list_template_folders, create_template_folder*, rename_template_folder*

**API Logs** (2): list_api_logs, get_api_log_details

**Contacts** (5): list_contacts, create_or_update_contact*, get_contact_details, delete_contact*, update_contact*

**Members** (4): list_workspace_members, get_current_member, get_member_details, create_member_token*

**Webhook subscriptions** (6): list_webhook_subscriptions*, create_webhook*, get_webhook_subscription_details*, update_webhook_subscription*, delete_webhook_subscription*, update_webhook_subscription_shared_key*

**Webhook events** (2): list_webhook_events, get_webhook_event_details

**Notary** (5): list_notaries, list_notarization_requests, create_notarization_request*, get_notarization_request_details, delete_notarization_request*

**Product catalog** (6): search_catalog_items, create_product_catalog_item*, get_product_catalog_item, update_product_catalog_item*, delete_product_catalog_item*, search_product_catalog_items (alias of search_catalog_items)

**Approval Workflows** (2): get_template_approval_workflow, update_template_approval_workflow*

**Privacy settings** (2): get_workspace_privacy_settings, update_workspace_privacy_settings*

**Quotes** (2): update_document_quote*, update_document_quotes*

**User and Workspace management** (11): list_workspaces, create_workspace*, deactivate_workspace*, list_users, create_user*, get_user_by_id, add_workspace_member*, remove_workspace_member*, change_workspace_member_role*, create_api_key*, update_workspace*

**Communication Preferences** (1): list_recent_sms_opt_outs

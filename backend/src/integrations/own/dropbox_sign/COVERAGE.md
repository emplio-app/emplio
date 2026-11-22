# Dropbox Sign coverage

Source: Dropbox Sign's official OpenAPI spec (github.com/hellosign/hellosign-openapi, openapi.yaml, API v3), generated
2026-11-22 by `bun scripts/openapi-actions.ts dropbox_sign`. Every operation is an action (81) except the two below.
Benchmark: Composio's dropbox_sign toolkit (56 tools, no triggers); all matched by name except as noted.

## Deliberately left out

| What | Why |
| --- | --- |
| POST /oauth/token, POST /oauth/token?refresh | OAuth sign-in plumbing; Emplio signs in with an API key |
| Composio's o_auth_authorize | The same OAuth plumbing |
| Composio's list_teams | The API has no call that lists every team: get_current_team, get_team_info and list_sub_teams cover it |
| callback_test event | Dropbox Sign's check that the callback address works; answered, never a trigger |

## Hand adjustments (scripts/openapi/dropbox_sign.ts, own/dropbox_sign/index.ts)

- Names follow Composio's where it has the same call (cancel_signature_request, download_signature_request_files,
  edit_and_resend_signature_request, update_signature_request, get_current_team, list_faxes...).
- Calls that take documents (send, templates, drafts, faxes, field detection, API app logos) go as JSON, or as multipart
  when a file from the computer is given in `files`/`file`/`signer_file`/`custom_logo_file`. Objects go in the
  multipart form as JSON text, as Dropbox Sign's SDKs send them.
- Downloads (signed copies, template files, faxes) come back as a file named after the id, with .pdf or .zip.
- get_api_app and list_api_apps ask first: they show the app's OAuth secret.

## Auth

| Method | Status |
| --- | --- |
| API key (Settings → API), sent as basic auth "KEY:" | done |
| OAuth | not built (key-only by decision) |

Sending real requests needs a paid Dropbox Sign API plan; `test_mode: true` works on any plan.

## Triggers (webhook, 29)

The account's callback URL (PUT /account callback_url) points at /webhooks/app/dropbox_sign/<connection>/<token>; one per
connection. An address someone else set is not overwritten (the automation fails with a clear message); an older Emplio
one is. Each event is checked with event_hash = HMAC-SHA256(API key, event_time + event_type), plus the unguessable token
in the address, and answered "Hello API Event Received". The callback is cleared when the last automation goes.
Filters: signature_request_id, template_id, signer_email.

signature_request_sent, _viewed, _signed, _all_signed, _downloadable, _declined, _reassigned, _remind, _email_bounce,
_invalid, _canceled, _expired, _prepared, _signer_removed, _destroyed, _incomplete_qes; file_error, unknown_error,
sign_url_invalid; template_created, template_error; account_confirmed; fax_received, fax_sent, fax_on_hold, fax_busy,
fax_no_answer, fax_disconnected, fax_blacklisted. Nothing is polled.

## Actions by group (* asks first)

**API Keys** (5): list_api_keys, create_api_key*, get_api_key, update_api_key*, delete_api_key*

**Account** (6): create_account*, get_account, update_account*, get_account_settings, modify_account_settings*, verify_account*

**Api App** (5): create_api_app*, get_api_app*, update_api_app*, delete_api_app*, list_api_apps*

**Bulk Send Job** (2): get_bulk_send_job, list_bulk_send_jobs

**Document** (1): detect_document_fields*

**Embedded** (2): get_embedded_template_edit_url*, get_embedded_sign_url

**Fax** (5): get_fax, delete_fax*, download_fax_files, list_faxes, send_fax*

**Fax Line** (7): add_fax_line_user*, get_fax_line_area_codes, purchase_fax_line*, get_fax_line, delete_fax_line*, list_fax_lines, remove_fax_line_access*

**Report** (1): create_report*

**Signature Request** (20): bulk_create_embedded_sig_req_with_template*, bulk_send_with_template*, cancel_signature_request*, create_embedded_signature_request*, create_embedded_signature_request_with_template*, edit_and_resend_signature_request*, edit_and_resend_embedded_signature_request*, edit_resend_embedded_signature_request_template*, edit_and_resend_signature_request_with_template*, download_signature_request_files, get_signature_request_files_as_data_uri, get_signature_request_files_as_file_url, get_signature_request, list_signature_requests, release_signature_request_hold*, send_signature_request_reminder*, remove_signature_request_access*, send_signature_request*, send_with_template*, update_signature_request*

**Team** (12): add_user_to_team*, create_team*, delete_team*, get_current_team, update_team*, get_team_info, list_team_invites, list_team_members, remove_user_from_team*, get_team_settings, modify_team_settings*, list_sub_teams

**Template** (11): add_user_to_template*, create_template*, create_embedded_template_draft*, delete_template*, get_template_files, get_template_files_as_data_uri, get_template_files_as_file_url, get_template, list_templates, remove_user_from_template*, update_template_files*

**Unclaimed Draft** (4): create_unclaimed_draft*, create_embedded_unclaimed_draft*, create_embedded_unclaimed_draft_with_template*, edit_and_resend_unclaimed_draft*

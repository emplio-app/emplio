# Typeform coverage

Source: Typeform's API reference (typeform.com/developers, Create, Responses and Webhooks APIs), read 2026-11-22 by
`bun scripts/openapi-actions.ts typeform`. Typeform publishes no OpenAPI spec, so scripts/openapi/typeform.ts builds one
from the reference pages themselves (each page's data has the method, path and request body; its HTML the parameters).
Every operation there is an action (49), plus two calls the reference leaves out (`/me`, and `/insights/{form_id}/summary`
from Typeform's own JS client) and one hand-written convenience (upload_video): 52.

Composio (35 actions, 1 trigger): all matched by name; we add translations, response search, single response files,
account workspaces, media master files, insights, partial responses and form polls.

## Deliberately left out

| What | Why |
| --- | --- |
| OAuth sign-in | Asked for a key-only connection; a personal access token covers every call (file downloads even require one) |
| Embed SDK, MCP server | Not API calls on the account |
| delete_responses' body | Typeform takes the ids in the query or the body; the query alone is sent |

## Hand adjustments (scripts/openapi/typeform.ts, own/typeform/index.ts)

- Names are Composio's where it has the call (get_about_me, get_form_responses, patch_form...), the rest from the page title.
- JSON Patch bodies (patch_form, update_workspace) are a whole `body` array: [{"op": "replace", "path": "/title", "value": "..."}].
- search_responses and batch_fetch_videos are POSTs that only read, so they run unasked; list_webhooks and get_webhook
  answer with each webhook's signing secret, so they ask first.
- upload_video: Typeform's upload is three steps (create_video_upload, PUT the file to its signed link, request the
  master file); this does all three with a file from the computer.
- Files (get_response_file, get_all_response_files as a zip, image binaries) come back as files.

## Auth

| Method | Status |
| --- | --- |
| Personal access token (Account → Personal tokens, tfp_...), sent as Bearer | done |
| EU data centres: the token pasted as `eu:tfp_...` (api.eu.typeform.com) or `typeform.eu:tfp_...` (api.typeform.eu) | done |
| OAuth | not built (key only, as asked) |

## Triggers

| Trigger | How |
| --- | --- |
| new_response (Composio's name) | webhook, per form: `form_response` |
| new_partial_response | webhook, per form: `form_response_partial` (only plans with partial responses) |
| new_form | polled every 5 min: list_forms by created_at |
| form_updated | polled every 5 min: list_forms by last_updated_at, id `<form>:<last_updated_at>` |

Webhooks are per form: tag `emplio_<connection>`, URL /webhooks/app/typeform/<connection>/<form>, signed with
Typeform-Signature (base64 HMAC-SHA256, secret from ENCRYPTION_KEY and the connection). A second event on the same form
is added to the same webhook; the last automation on the form deletes it. Events carry each answer as
{question, ref, type, answer} with choices as their labels, plus hidden fields, score, variables and ending.
Typeform sends nothing for forms, themes, images or workspaces changing, hence the polls.

## Limits

- Rate limit: 2 requests a second per Typeform account (Create and Responses APIs).
- get_form_responses may miss responses from the last ~30 minutes; the webhook triggers don't.
- Partial responses only on Typeform plans that include them.

## Actions by group (* asks first)

**Account** (1): get_about_me

**Workspaces** (7): list_workspaces, get_workspace, create_workspace*, update_workspace*, delete_workspace*, list_account_workspaces, create_account_workspace*

**Forms** (9): list_forms, get_form, create_form*, update_form*, patch_form*, delete_form*, get_form_messages, update_form_messages*, get_form_insights

**Translations** (6): get_translation_payload, get_translation_statuses, get_form_translation, update_form_translation*, delete_form_translation*, auto_translate_form*

**Responses** (5): get_form_responses, search_responses, delete_responses*, get_all_response_files, get_response_file

**Webhooks** (4): list_webhooks*, get_webhook*, create_or_update_webhook*, delete_webhook*

**Images** (7): list_images, get_image, get_image_by_size, get_background_by_size, get_choice_image_by_size, create_image*, delete_image*

**Videos and audio** (7): upload_video*, create_video_upload*, batch_fetch_videos, request_video_master_file*, get_video_master_file, request_audio_master_file*, get_audio_master_file

**Themes** (6): list_themes, get_theme, create_theme*, update_theme*, patch_theme*, delete_theme*

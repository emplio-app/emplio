# Figma coverage

Source: Figma's OpenAPI spec (github.com/figma/rest-api-spec, openapi/openapi.yaml v0.47.0), generated 2026-11-22 by
`bun scripts/openapi-actions.ts figma`. Every operation a personal access token may call is an action (46), plus one
hand-written (download_figma_images): 47. Benchmark: Composio's figma toolkit (53 tools, no triggers).

## Deliberately left out

| What | Why |
| --- | --- |
| duplicate file, create team, invite to team, create team folder | Only a private OAuth app on an Enterprise plan may call them |
| get team, folder metadata, activity logs, developer logs, AI usage | Plan access token (or an organization's OAuth app) only; Emplio connects with a personal access token |
| team projects, project files, project metadata (v1) | Deprecated by Figma: folders replaced projects. get_projects_in_a_team and get_files_in_a_project are the v2 folder calls, under Composio's names |
| get team webhooks (v2) | Deprecated by Figma; get_webhooks_by_context_or_plan with context team does the same |
| Composio's get_activity_logs | Plan access token only (above) |
| Composio's design_tokens_to_tailwind, extract_design_tokens, detect_background, extract_prototype_interactions, discover_figma_resources | Composio's own processing of get_file_json / get_file_nodes / a pasted link, not Figma calls; Emplio reads the file and works it out itself |
| Composio's get_component2, get_scim_service_provider_config | A duplicate of get_component; SCIM is for identity providers with an admin SCIM token |
| OAuth sign-in | Not built (key only, as asked). Figma's OAuth apps need publishing review before strangers can use them |

## Hand adjustments (scripts/openapi/figma.ts, own/figma/index.ts)

- The token goes in `X-Figma-Token`. A bad or expired one is a 403 "Invalid token", read as a dead login.
- file_key, team_id and folder_id say where to find them in a Figma link.
- get_top_level_folders_in_team → get_projects_in_a_team, get_files_in_folder → get_files_in_a_project (Composio's names).
- download_figma_images: renders layers and hands them back as files (render_images_of_file_nodes gives links).

## Auth

| Method | Status |
| --- | --- |
| Personal access token (Figma → Settings → Security → Personal access tokens), sent as X-Figma-Token | done |
| OAuth | not built |

Tokens expire on the date picked when making them; the person makes a new one and reconnects.

## Triggers

Webhook (webhooks v2, own/figma/triggers.ts): one Figma webhook per connection, place (file, folder or team) and event,
at /webhooks/app/figma/<connection>/<context>-<id>-<EVENT>; Figma's passcode in the body is an HMAC of ENCRYPTION_KEY,
the connection and the place. Each trigger takes one of file / folder_id / team_id, and file_key to narrow a folder or team.

| Trigger | Figma event |
| --- | --- |
| file_updated | FILE_UPDATE (after 30 minutes without edits) |
| file_deleted | FILE_DELETE (comes on the FILE_UPDATE webhook, so it takes no extra webhook place) |
| file_version_created | FILE_VERSION_UPDATE |
| new_comment | FILE_COMMENT |
| library_published | LIBRARY_PUBLISH |
| dev_mode_status_changed | DEV_MODE_STATUS_UPDATE (filter: status) |

Polled (polls/figma.ts), for what no webhook reports or needs edit rights to watch:

| Trigger | How |
| --- | --- |
| new_project_in_team | get_projects_in_a_team, folders by created_at |
| file_changed_in_project | get_files_in_a_project, id = key + last_modified (works with view access) |

Figma's limits: webhooks on a team need a team admin, on a folder or file edit rights; 20 per team, 5 per folder, 3 per
file, and 150/300/600 file webhooks per Professional/Organization/Enterprise plan. Team webhooks skip invite-only folders.

## Actions by group (* asks first)

**hand-written** (1): download_figma_images

**Files** (6): get_file_json, get_file_nodes, render_images_of_file_nodes, get_image_fills, get_file_metadata, get_versions_of_a_file

**Folders** (3): get_projects_in_a_team, get_subfolders_in_folder, get_files_in_a_project

**Comments** (3): get_comments_in_a_file, add_a_comment_to_a_file*, delete_a_comment*

**Comment Reactions** (3): get_reactions_for_a_comment, add_a_reaction_to_a_comment*, delete_a_reaction*

**Users** (1): get_current_user

**Components** (3): get_team_components, get_file_components, get_component

**Component Sets** (3): get_team_component_sets, get_file_component_sets, get_component_set

**Styles** (3): get_team_styles, get_file_styles, get_style

**Webhooks** (6): get_webhooks_by_context_or_plan, create_a_webhook*, get_a_webhook, update_a_webhook*, delete_a_webhook*, get_webhook_requests

**Payments** (1): get_payments

**Variables** (3): get_local_variables, get_published_variables, create_modify_delete_variables*

**Dev Resources** (4): get_dev_resources, create_dev_resources*, update_dev_resources*, delete_dev_resource*

**Library Analytics** (6): get_library_analytics_component_action_data, get_library_analytics_component_usage_data, get_library_analytics_style_action_data, get_library_analytics_style_usage_data, get_library_analytics_variable_action_data, get_library_analytics_variable_usage_data

**oEmbed** (1): get_o_embed_data

# Airtable coverage

Source: Airtable's Web API reference (airtable.com/developers/web/api, whose pages embed its OpenAPI document), checked 2026-11-09. Calls are written by hand with `rest()`, split by resource: `records.ts`, `schema.ts`, `webhooks.ts`, `admin.ts` (66 actions).

## Deliberately left out

| What | Why |
| --- | --- |
| `/meta/enterpriseAccounts/*`, SCIM, audit logs, eDiscovery, `/meta/groups`, HyperDB tables, `create-workspace` | Enterprise-account administration; a business's personal access token can't call them without being an Enterprise admin, and they're not about the business's bases |
| `POST /v0/meta/revoke` | Revoking the token Emplio is connected with would only break the connection |

Enterprise-plan calls on a base or workspace (views, collaborators, shares, interfaces, extensions, workspaces) are included; on other plans Airtable answers with a permission error.

## Sign-in

| Method | Status |
| --- | --- |
| Personal access token (airtable.com/create/tokens), sent as a Bearer token | done |
| OAuth | not in this job |

## Hand adjustments

- `list_records` uses `POST .../listRecords`, Airtable's way of keeping long filters and sorts in the body. It only reads, so it runs without asking.
- Lists in the query go as `name[]=x` (`delete_multiple_records`, `include` options), which is how Airtable reads them.
- `upload_attachment` goes to content.airtable.com as base64 (5 MB limit). `sync_csv_data` posts raw CSV.
- Added on top: `get_attachment_info`, `get_base_metadata` (Airtable has no call for one base's name, so it searches `list_bases`).

## Triggers (all polled)

Airtable's webhooks stop after 7 days and need a cursor kept between deliveries, so a pasted token can't rely on them; the webhook calls are actions only.

| Trigger | How | Limits |
| --- | --- | --- |
| `new_record` | `CREATED_TIME()` in the last day; `view` and `formula` filters | 5 pages of 100 per check |
| `record_updated` | `LAST_MODIFIED_TIME()` in the last day, id holds a hash of the cells people set (formulas, lookups and similar left out); a record never edited since it was added isn't reported | |
| `base_metadata_changed_trigger` | Id holds name and permission | A base newly shared with the token counts as well |
| `base_schema_changed_trigger` | Id holds a hash of tables, fields and views | |
| `user_profile_changed_trigger` | Id holds a hash of `whoami` | Only what Airtable reports: id, email, scopes |
| `view_created_trigger`, `view_metadata_changed_trigger` | From the base schema, so they work on every plan | Name and type only; a brand-new view also counts as changed |
| `view_deleted_trigger` | The base's last list of views is kept in the server's memory and compared; each deletion stays reported for a day so every automation on the base gets it | A view deleted while the server is down isn't noticed |

## Compared with Composio (`coverage.ts airtable`)

Triggers: all 6 match, plus `new_record` and `record_updated`. Actions not matched by name, none a missing capability:

| Composio | Ours |
| --- | --- |
| `create_multiple_records` (deprecated by Composio) | `create_records` |
| `get_user_info` | `who_am_i` (same call) |
| `create_record_from_natural_language` | Composio's own language step; Emplio writes the record itself |

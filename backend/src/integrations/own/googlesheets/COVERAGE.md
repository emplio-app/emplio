# Google Sheets coverage

Source: the Sheets API Discovery document (sheets.googleapis.com/$discovery/rest?version=v4), generated 2026-11-09 by `bun scripts/openapi-actions.ts googlesheets`. 17 from the API and 44 added on top (61 actions), 16 triggers.

## Sign-in

Google sign-in only (no key), shared with Calendar, Docs and Meet: one OAuth client, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Callback `/oauth/googlesheets/callback`.

| Scope | Google's class |
| --- | --- |
| `spreadsheets` | Sensitive |
| `drive.file` | Non-sensitive (Google's recommended scope) |
| `openid`, `email` | Non-sensitive |

Only scopes Google classes as sensitive or non-sensitive are asked for. The test in `own/google-login.test.ts` fails if a restricted one appears (`drive`, `drive.readonly`, `drive.metadata`, `drive.meet.readonly`...). Tokens last an hour and renew with the refresh token (`offline`, `prompt=consent`).

## What Google's drive.file scope means here

**Emplio can't browse or search the person's Drive.** `spreadsheets` reaches any spreadsheet they can reach *when given its id or link*; Drive actions see only files Emplio made.

- Works: `search_spreadsheets`, `get_drive_file_metadata`, `export_drive_file`, `export_sheet_as_pdf`, `move_spreadsheet_to_folder`, `list_drive_changes`, for files Emplio made.
- Doesn't exist with these scopes: listing all spreadsheets, or exporting one Emplio didn't make.

## Left out

| What | Why |
| --- | --- |
| `execute_sql` (Composio) | Deprecated there: it parses SQL over guessed tables and skips the first data row. `query_table`, `lookup_spreadsheet_row`, `aggregate_column_data`, `upsert_rows` and `spreadsheets_batch_update` do its jobs |

## Hand adjustments

- `batchUpdate` is one API method; each request Composio named is its own action (`singles`), and anything else goes through `spreadsheets_batch_update`.
- `append_rows`, `read_rows`, `upsert_rows`, `lookup_spreadsheet_row` and `query_table` work by column heading (first row). Columns can be named or given by letter.
- `query_table` is one column equals one value, a sort and a limit, not SQL.
- `reads`: `get_spreadsheet_by_data_filter`, `spreadsheets_values_batch_get_by_data_filter`, `search_developer_metadata` run without asking. `spreadsheets_values_append` and every other write asks.
- `get_batch_values` is an alias, as Composio had it twice. `valueInputOption`'s description says it's required when writing, as Discovery doesn't.
- `batch_update` is Composio's meaning: write values to one range, or append when no start cell is given.

## Triggers (all polled, every 5 minutes)

Sheets has no push for changes inside a spreadsheet. Everything but `new_spreadsheet_created` and `spreadsheet_search_match` watches one spreadsheet (`spreadsheet_id`). A change is a new hash of what's read, so a change back to a state already seen isn't reported again.

| Trigger | Watches | Limits |
| --- | --- | --- |
| `new_rows_trigger` | Rows by number, last 500 of a tab; filter by column | A row inserted above pushes the last row down, which looks new |
| `new_sheet_added_trigger` | Tab ids | |
| `worksheet_names_changed_trigger` | Tab names | |
| `cell_range_values_changed_trigger`, `filtered_range_values_changed_trigger`, `table_query_result_changed_trigger` | A range or a column-equals-value lookup | Not SQL |
| `spreadsheet_row_changed_trigger` | One row, found by a value | |
| `aggregate_metric_changed_trigger` | Sum, average, count, min or max of a column | |
| `table_schema_changed_trigger` | The header row | |
| `conditional_format_rule_changed_trigger`, `developer_metadata_changed_trigger`, `spreadsheet_properties_changed_trigger`, `spreadsheet_metadata_changed_trigger` | Google's fields for each | |
| `data_validation_rule_changed_trigger` | Dropdowns and limits on cells; big sheets are slow without `ranges` | |
| `new_spreadsheet_created_trigger`, `spreadsheet_search_match_trigger` | Drive list | **Narrower than Composio's: only spreadsheets Emplio made** |

## Actions (* asks first)

**From the API** (17): get_spreadsheet_info, get_spreadsheet_by_data_filter, create_google_sheet1*, spreadsheets_batch_update*, spreadsheets_sheets_copy_to*, search_developer_metadata, get_developer_metadata, batch_update_values_by_data_filter*, spreadsheets_values_append*, batch_get, clear_values*, spreadsheets_values_batch_clear*, spreadsheets_values_batch_get_by_data_filter, values_update*, values_get, batch_clear_values_by_data_filter*, update_values_batch*

**Added on top** (44): add_sheet*, delete_sheet*, update_sheet_properties*, update_spreadsheet_properties*, append_dimension*, insert_dimension*, delete_dimension*, auto_resize_dimensions*, update_dimension_properties*, create_spreadsheet_row*, create_spreadsheet_column*, find_replace*, format_cell*, sort_range*, set_basic_filter*, clear_basic_filter*, set_data_validation_rule*, create_chart*, update_chart*, delete_chart*, move_chart*, get_sheet_names, find_worksheet_by_title, get_conditional_format_rules, get_data_validation_rules, list_charts, list_tables, get_table_schema, read_rows, query_table, lookup_spreadsheet_row, aggregate_column_data, append_rows*, upsert_rows*, sheet_from_json*, batch_update*, mutate_conditional_format_rules*, search_spreadsheets, get_drive_file_metadata, export_drive_file, export_sheet_as_pdf, move_spreadsheet_to_folder*, list_drive_changes, get_batch_values

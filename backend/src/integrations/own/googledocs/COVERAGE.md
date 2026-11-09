# Google Docs coverage

Source: the Docs API Discovery document (docs.googleapis.com/$discovery/rest?version=v1), generated 2026-11-09 by `bun scripts/openapi-actions.ts googledocs`. 3 from the API and 43 added on top (46 actions), 10 triggers.

## Sign-in

Google sign-in only (no key), shared with Calendar, Sheets and Meet: one OAuth client, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Callback `/oauth/googledocs/callback`.

| Scope | Google's class |
| --- | --- |
| `documents` | Sensitive |
| `drive.file` | Non-sensitive (Google's recommended scope) |
| `openid`, `email` | Non-sensitive |

Only scopes Google classes as sensitive or non-sensitive are asked for. The test in `own/google-login.test.ts` fails if a restricted one appears (`drive`, `drive.readonly`, `drive.metadata`, `drive.meet.readonly`...). Tokens last an hour and renew with the refresh token (`offline`, `prompt=consent`).

## What Google's drive.file scope means here

**Emplio can't browse or search the person's Drive.** `documents` reaches any document they can reach *when given its id or link*. Drive actions see only files Emplio made (`drive.file` also grants files a person picks through Google's file picker, which we don't have):

- Works: `search_documents`, `get_docs_drive_file_metadata`, `list_drive_item_permissions`, `copy_document`, `export_document_as_pdf`, `create_drive_file` and `upload_drive_file`, for files Emplio made. A file it didn't make answers "Drive can't find that file" and says why.
- Doesn't exist with these scopes: searching or listing all documents, copying or exporting a document Emplio didn't make, knowing about documents someone else created.

## Left out

| What | Why |
| --- | --- |
| `get_docs_spreadsheet_values`, `list_spreadsheet_charts` (Composio) | These read spreadsheets: they belong to Google Sheets (`googlesheets.values_get`, `list_charts`), and the Docs sign-in doesn't ask for `spreadsheets` |

## Hand adjustments

- `batchUpdate` is one API method; each request Composio named is its own action through `singles`, with inputs that are the request's own fields. Everything else in `batchUpdate` is reachable through `update_document_batch`.
- Markdown (`create_document_markdown`, `update_document_markdown`, `update_document_section_markdown`) is converted to Docs requests by `text.ts`: headings, bullets, numbered lists, bold, italic, code and links. A Markdown table or image comes through as plain text.
- `create_and_populate_table` adds the table, re-reads for its cell positions, then fills them from the last cell back.
- `create_document2`, `update_existing_document` are aliases, as Composio had them twice.
- Without `tabId`, actions work on the document's first tab.

## Triggers (all polled, every 5 minutes)

| Trigger | How | Limits |
| --- | --- | --- |
| `document_updated_trigger` | One document, `revisionId` | Google says a new revision id usually means a change, rarely an internal one |
| `document_placeholder_filled_trigger` | One document; reported once the text is gone | Turn on while the placeholder is still there |
| `document_structure_changed_trigger` | One document; hash of headers, footers, footnotes, tables, images | Counts tables; resizing one isn't a change |
| `document_word_count_threshold_trigger` | One document; once, when it reaches the number | |
| `keyword_detected_trigger` | One document; once per word, as Composio's | |
| `document_created_trigger`, `page_added_trigger` | Drive list, created in the last day | **Narrower than Composio's: only documents Emplio made**. `page_added_trigger` is the same event, as it was on Composio |
| `document_deleted_trigger` | Drive list in the trash | Only documents Emplio made. Permanently deleted ones can't be seen |
| `document_search_update_trigger` | Drive search by name or text | Only documents Emplio made |
| `folder_created_trigger` | Drive list of folders | Only folders Emplio made; Composio's watched the root of the whole Drive, which needs a restricted scope |

## Actions (* asks first)

**From the API** (3): update_document_batch*, get_document_by_id, create_document*

**Added on top** (43): insert_text_action*, replace_all_text*, delete_content_range*, insert_page_break*, insert_table_action*, insert_inline_image*, create_footer*, create_header*, create_footnote*, delete_footer*, delete_header*, create_named_range*, delete_named_range*, create_paragraph_bullets*, delete_paragraph_bullets*, create_tab*, delete_tab*, update_tab_properties*, insert_table_row*, insert_table_column*, delete_table_row*, delete_table_column*, unmerge_table_cells*, update_table_row_style*, replace_image*, update_document_style*, get_document_plaintext, get_document_end_index, create_document_markdown*, update_document_markdown*, update_document_section_markdown*, create_and_populate_table*, insert_text_in_table_cell*, insert_image_in_table_cell*, search_documents, get_docs_drive_file_metadata, list_drive_item_permissions, export_document_as_pdf, copy_document*, create_drive_file*, upload_drive_file*, create_document2*, update_existing_document*

# Notion coverage

Source: Notion's OpenAPI spec (developers.notion.com/openapi.json), generated 2026-11-09 by `bun scripts/openapi-actions.ts notion`.
Every operation in it is an action (62), plus four hand-written conveniences. Sent with the `Notion-Version` the spec is written for
(`version.json`, written by the generator).

## Deliberately left out

| What | Why |
| --- | --- |
| `POST /v1/oauth/token`, `/oauth/revoke`, `/oauth/introspect` | Need the integration's client secret, not a connected token |
| `PATCH /v1/agents/{agent_id}/status` | Notion marks it deprecated |

## Sign-in

| Method | Status |
| --- | --- |
| Internal integration secret (notion.so/profile/integrations), sent as a Bearer token | done |
| OAuth | not in this job |

Notion only shows an integration the pages shared with it, so the connect help says to add the integration on each page.

## Hand adjustments

- `scripts/openapi/notion.ts`: Composio's names through `namer` plus `rename`; POST lookups run without asking (`query_data_source`, `search_notion_page`, `query_meeting_notes`, `query_agents`, `query_sessions`, `query_session_events`, `create_view_query`).
- `index.ts` overrides four actions whose bodies are a choice of shapes the generator flattens away: `update_page_markdown`, `create_comment`, `update_comment`, `create_meeting_note`.
- Added on top: `archive_notion_page`, `replace_page_content`, `duplicate_page` (title and content only; child pages and databases aren't copied), `upsert_row_database`.

## Triggers (all polled)

Notion's webhooks are set up by hand in its integration screen, so a pasted secret can't register them. Everything is polled with `search` (newest edited first), every 5 minutes by default.

| Trigger | How | Limits |
| --- | --- | --- |
| `page_created` | `created_time` in the last day | |
| `page_properties_updated` | Id holds a hash of the stored properties (formulas, rollups and last-edited columns left out) | Notion has no per-property time. The first change seen on a page never checked before is reported even if it was a content edit; a new page counts as well |
| `page_content_updated` | Id holds `last_edited_time` | Notion keeps one last-edited time per page, so a property edit is reported here too. To tell them apart we'd have to read every recently edited page's blocks on each poll, too many calls at Notion's 3 a second. Times are to the minute, so a second edit in the same minute as a poll is reported at the next edit |
| `datasource_created`, `database_created` | `created_time` in the last day; a new table in an old database isn't a new database | |
| `datasource_schema_updated` | Id holds a hash of the columns | A brand-new data source counts as well |
| `comment_created` | `block_id` required: Notion lists comments per page or block only | |
| `view_created` | `list_views`, per database | Views have no created time, so "new" means not seen before. Without `database_id`, the 25 most recently edited databases are checked |

Search returns 100 at a time and is eventually consistent, so more than 100 pages edited between two polls can miss some.

## Compared with Composio (`coverage.ts notion`)

Triggers: all 8 match. Actions not matched by name, none a missing capability:

| Composio | Ours |
| --- | --- |
| `get_about_me` | `who_am_i` (same call) |
| `fetch_row` | `retrieve_page` |
| `fetch_data` | `search_notion_page` |
| `insert_row_database` | `create_notion_page` with a data source parent |
| `update_row_database` | `update_page` |
| `query_database`, `query_database_with_filter` | `query_data_source` (Notion now queries data sources; `fetch_database` lists a database's) |
| `retrieve_database_property` | `retrieve_data_source` holds every property |
| `add_page_content`, `add_multiple_page_content`, `append_text_blocks`, `append_code_blocks`, `append_layout_blocks`, `append_media_blocks`, `append_table_blocks`, `append_task_blocks` | `append_block_children` (any block type) or `update_page_markdown` |
| `fetch_all_block_contents` | `get_page_markdown` for a whole page, `fetch_block_contents` per level |
| `insert_row_from_nl` | Composio's own language step; Emplio writes the row itself |

// Google Sheets: every method in its Discovery document, under Composio's names. batchUpdate's requests one by one, and rows as rows, are in own/googlesheets/index.ts.
import { GOOGLE_SCOPES } from "../../src/integrations/own/google-login";
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";
import { discovery } from "./google-discovery";

export default {
  spec: await discovery("https://sheets.googleapis.com/$discovery/rest?version=v4", "googlesheets", GOOGLE_SCOPES.googlesheets),
  out: "src/integrations/own/googlesheets/actions.json",
  name: namer(await composioNames("googlesheets")),
  rename: {
    spreadsheets_get: "get_spreadsheet_info",
    spreadsheets_create: "create_google_sheet1",
    spreadsheets_get_by_data_filter: "get_spreadsheet_by_data_filter",
    spreadsheets_values_clear: "clear_values",
    spreadsheets_values_update: "values_update",
    spreadsheets_values_batch_get: "batch_get",
    spreadsheets_values_batch_update: "update_values_batch",
    spreadsheets_values_batch_clear_by_data_filter: "batch_clear_values_by_data_filter",
    spreadsheets_values_get: "values_get",
    spreadsheets_values_batch_update_by_data_filter: "batch_update_values_by_data_filter",
    spreadsheets_developer_metadata_search: "search_developer_metadata",
    spreadsheets_developer_metadata_get: "get_developer_metadata",
  },
  // POSTs that only look things up
  reads: ["get_spreadsheet_by_data_filter", "spreadsheets_values_batch_get_by_data_filter", "search_developer_metadata"],
  params: { valueInputOption: "Required when writing. USER_ENTERED reads values as if typed (formulas, dates); RAW stores them exactly as given" },
} satisfies AppConfig;

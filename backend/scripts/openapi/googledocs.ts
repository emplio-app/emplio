// Google Docs: every method in its Discovery document, under Composio's names. batchUpdate's requests one by one are in own/googledocs/index.ts.
import { GOOGLE_SCOPES } from "../../src/integrations/own/google-login";
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";
import { discovery } from "./google-discovery";

export default {
  spec: await discovery("https://docs.googleapis.com/$discovery/rest?version=v1", "googledocs", GOOGLE_SCOPES.googledocs),
  out: "src/integrations/own/googledocs/actions.json",
  name: namer(await composioNames("googledocs")),
  rename: { documents_get: "get_document_by_id", documents_create: "create_document", documents_batch_update: "update_document_batch" },
} satisfies AppConfig;

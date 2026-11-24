// Leexi: what the generator (../openapi-actions.ts) can't tell from the spec. Leexi publishes one OpenAPI file at
// https://public-api.leexi.ai/v1/openapi.json (the reference at docs.public-api.leexi.ai is built from it).
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

export default {
  spec: "https://public-api.leexi.ai/v1/openapi.json",
  out: "src/integrations/own/leexi/actions.json",
  name: namer(await composioNames("leexi")),
  // Leexi's summaries for a client company's teams and users are the same as the company's own ("Create a team"), so
  // the generator fell back to the operation id
  rename: {
    create_a_client_team: "create_client_team",
    update_a_client_team: "update_client_team",
    delete_a_client_team: "delete_client_team",
    create_a_client_user: "create_client_user",
    update_a_client_user: "update_client_user",
    deactivate_a_client_user: "deactivate_client_user",
  },
  // only hands back an address to upload a recording to; nothing changes until create_call
  reads: ["request_presigned_url"],
} satisfies AppConfig;

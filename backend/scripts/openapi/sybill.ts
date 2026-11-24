// Sybill: what the generator (../openapi-actions.ts) can't tell from the spec. The spec is the one linked from
// Sybill's API docs (api.sybill.ai/docs). Composio has no Sybill toolkit, so names come from the summaries.
import type { AppConfig } from "../openapi-actions";
import { namer } from "./composio-names";

export default {
  spec: "https://api.sybill.ai/docs/openapi.yaml",
  out: "src/integrations/own/sybill/actions.json",
  name: namer([]),
  rename: { health_check: "check_key" },
  // a question about the workspace's calls and deals changes nothing
  reads: ["ask_sybill"],
} satisfies AppConfig;

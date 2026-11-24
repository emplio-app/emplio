// Granola: what the generator (../openapi-actions.ts) can't tell from the spec (docs.granola.ai/api-reference/openapi.json).
// One operation has no operationId, so this names it in a copy of the spec and hands that to the generator.
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";

const spec = (await (await fetch("https://docs.granola.ai/api-reference/openapi.json")).json()) as Record<string, any>;
spec.paths["/v1/analytics"].get.operationId ??= "get_workspace_analytics";
const SPEC = `${tmpdir()}/granola-openapi.json`;
await Bun.write(SPEC, JSON.stringify(spec));

export default {
  spec: SPEC,
  out: "src/integrations/own/granola/actions.json",
  // POSTs that only look things up
  reads: ["search_notes", "search_transcripts"],
  params: {
    note_id: "The note's id (not_...); list_notes and search_notes give it",
    folder_id: "A folder's id (fol_...); list_folders lists them",
    space_id: "A space's id (spa_...); list_spaces lists them",
    webhook_endpoint_id: "The webhook endpoint's id (whe_...); list_webhook_endpoints lists them",
    hold_id: "The legal hold's id; list_legal_holds lists them",
  },
} satisfies AppConfig;

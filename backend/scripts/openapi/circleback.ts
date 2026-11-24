// Circleback: what the generator (../openapi-actions.ts) can't tell from the spec.
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";

// Circleback's spec has no operation ids, so each operation gets one from its summary ("List action items" →
// list_action_items) in a copy the generator then reads.
const SPEC = "https://circleback.ai/docs/api/openapi.json";
const spec = await (await fetch(SPEC)).json();
for (const ops of Object.values<Record<string, any>>(spec.paths))
  for (const op of Object.values<any>(ops)) if (op?.summary) op.operationId ??= op.summary.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const copy = `${tmpdir()}/circleback-openapi.json`;
await Bun.write(copy, JSON.stringify(spec));

export default {
  spec: copy,
  out: "src/integrations/own/circleback/actions.json",
  rename: { get_the_current_account: "get_current_account" },
} satisfies AppConfig;

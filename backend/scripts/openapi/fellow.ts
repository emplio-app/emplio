// Fellow: what the generator (../openapi-actions.ts) can't tell from the docs. Fellow publishes no single spec, but
// every endpoint page of its reference (developers.fellow.ai/reference/<operation>.md, listed in llms.txt) carries
// the OpenAPI definition of its own operation. This merges them into one spec and hands that to the generator.
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";

type Schema = Record<string, any>;
const DOCS = "https://developers.fellow.ai";

async function build() {
  const index = await (await fetch(`${DOCS}/llms.txt`)).text();
  const pages = [...index.matchAll(/\((https:[^)]+\/reference\/apps_developer_api_api_[^)]+\.md)\)/g)].map((m) => m[1]!);
  const merged: Schema = { openapi: "3.1.0", info: { title: "Fellow Developer API", version: "1" }, paths: {}, components: { schemas: {} } };
  for (const page of pages) {
    const md = await (await fetch(page)).text();
    const json = /# OpenAPI definition\s*```json\n([\s\S]+?)\n```/.exec(md)?.[1];
    if (!json) throw new Error(`no OpenAPI definition on ${page}`);
    const one = JSON.parse(json);
    for (const [path, ops] of Object.entries<Schema>(one.paths)) Object.assign((merged.paths[path] ??= {}), ops);
    Object.assign(merged.components.schemas, one.components?.schemas);
  }
  return merged;
}

const SPEC = `${tmpdir()}/fellow-openapi.json`;
await Bun.write(SPEC, JSON.stringify(await build()));

export default {
  spec: SPEC,
  out: "src/integrations/own/fellow/actions.json",
  name: (id) =>
    id
      .replace(/^apps_developer_api_api_/, "")
      .replace(/_by_id$/, "")
      .replace(/^get_(recordings|notes|action_items)$/, "list_$1"),
  rename: { get_authenticated_user: "get_me", write_note_agenda: "replace_note_agenda" },
  // POST lists: they only look things up
  reads: ["list_recordings", "list_notes", "list_action_items", "list_uploads"],
  params: {
    note_id: "The note's id; list_notes lists them",
    recording_id: "The recording's id; list_recordings lists them",
    action_item_id: "The action item's id; list_action_items lists them",
    webhook_id: "The webhook's id; list_webhooks lists them",
  },
} satisfies AppConfig;

// Avoma: what the generator (../openapi-actions.ts) can't tell from the spec (dev.avoma.com/openapi.yml). Most of
// Avoma's operations have no operationId, one path lacks its leading slash, and its schemas live in a second file
// (openapi/components/external.yml), so this fixes those into one copy of the spec and hands that to the generator.
import { tmpdir } from "node:os";
import type { AppConfig } from "../openapi-actions";

// Composio's names where it has the call, so skills and automations written for it carry over
const NAMES: Record<string, string> = {
  "GET /v1/calls/": "list_calls",
  "POST /v1/calls/": "create_call",
  "GET /v1/calls/{external_id}/": "get_call",
  "PATCH /v1/calls/{external_id}/": "update_call",
  "GET /v1/custom_categories/": "list_custom_categories",
  "GET /v1/custom_categories/{uuid}/": "get_custom_category",
  "GET /v1/meeting_segments/": "list_meeting_segments",
  "GET /v1/meeting_sentiments/": "get_meeting_sentiments",
  "GET /v1/meetings/": "list_meetings",
  "GET /v1/meetings/{meeting_uuid}/insights/": "get_meeting_analysis",
  "GET /v1/meetings/{uuid}/": "get_meeting",
  "POST /v1/meetings/{uuid}/drop/": "drop_meeting",
  "GET /v1/notes/": "list_notes",
  "GET /v1/recordings/": "get_recording",
  "GET /v1/recordings/{uuid}/": "get_recording_by_id",
  "GET /v1/scorecard_evaluations/": "list_scorecard_evaluations",
  "GET /v1/scorecards/": "list_scorecards",
  "GET /v1/scorecards/{uuid}/": "get_scorecard",
  "GET /v1/smart_categories/": "list_smart_categories",
  "POST /v1/smart_categories/": "create_smart_category",
  "GET /v1/smart_categories/{uuid}/": "get_smart_category",
  "PATCH /v1/smart_categories/{uuid}/": "update_smart_category",
  "GET /v1/template/": "list_templates",
  "POST /v1/template/": "create_template",
  "GET /v1/template/{uuid}/": "get_template",
  "PUT /v1/template/{uuid}/": "update_template",
  "GET /v1/transcriptions/": "list_transcriptions",
  "GET /v1/transcriptions/{uuid}/": "get_transcription",
  "GET /v1/meeting_type/": "list_meeting_types",
  "POST /v1/meeting_type/": "create_meeting_type",
  "GET /v1/meeting_type/{uuid}/": "get_meeting_type",
  "PATCH /v1/meeting_type/{uuid}/": "update_meeting_type",
  "DELETE /v1/meeting_type/{uuid}/": "delete_meeting_type",
  "GET /v1/meeting_outcome/": "list_meeting_outcomes",
  "POST /v1/meeting_outcome/": "create_meeting_outcome",
  "GET /v1/meeting_outcome/{uuid}/": "get_meeting_outcome",
  "PATCH /v1/meeting_outcome/{uuid}/": "update_meeting_outcome",
  "DELETE /v1/meeting_outcome/{uuid}/": "delete_meeting_outcome",
  "GET /v1/users/": "list_users",
  "GET /v1/users/{uuid}/": "get_user",
  "GET /v1/engagement/": "list_engagement_metrics",
  "GET /v1/engagement/{user_uuid}/": "get_user_engagement_metrics",
  "GET /v1/engagement/summary/": "get_engagement_summary",
  "GET /v1/engagement/{user_uuid}/summary/": "get_user_engagement_summary",
  "GET /v1/snippets/": "list_snippets",
  "GET /v1/revenue_intel/timeline/": "get_revenue_timeline",
  "GET /v1/revenue_intel/timeline_details/": "list_revenue_timeline_details",
  "GET /v1/webhooks/": "list_webhooks",
  "POST /v1/webhooks/": "create_webhook",
  "DELETE /v1/webhooks/{uuid}/": "delete_webhook",
  "GET /v1/webhooks/signing-secret/": "get_webhook_signing_secret",
  "PATCH /v1/webhooks/signing-secret/": "set_webhook_signing_secret",
  "DELETE /v1/webhooks/signing-secret/": "clear_webhook_signing_secret",
  "POST /v1/webhooks/signing-secret/rotate/": "rotate_webhook_signing_secret",
};
// the shape of what Avoma sends to a webhook, listed as if it were a call
const PAYLOADS = /^\/v1\/webhooks\/(ainote|meeting_booked_via_scheduler\w*|new_conversation)\/$/;

async function build() {
  const get = async (path: string) => (await (await fetch(`https://dev.avoma.com/${path}`)).text()).replaceAll("./openapi/components/external.yml#", "#");
  const spec = Bun.YAML.parse(await get("openapi.yml")) as Record<string, any>;
  const external = Bun.YAML.parse(await get("openapi/components/external.yml")) as Record<string, any>;
  for (const [kind, items] of Object.entries<any>(external.components)) spec.components[kind] = { ...items, ...spec.components[kind] };
  const paths: Record<string, any> = {};
  for (const [raw, ops] of Object.entries<any>(spec.paths)) {
    const path = raw.startsWith("/") ? raw : `/${raw}`;
    for (const [method, op] of Object.entries<any>(ops)) {
      if (method === "parameters" || PAYLOADS.test(path)) continue;
      const call = `${method.toUpperCase()} ${path}`;
      if (!NAMES[call]) throw new Error(`Avoma has a new call, ${call}: give it a name in NAMES`);
      op.operationId = NAMES[call];
    }
    paths[path] = ops;
  }
  return { ...spec, paths };
}

const SPEC = `${tmpdir()}/avoma-openapi.json`;
await Bun.write(SPEC, JSON.stringify(await build()));

export default {
  spec: SPEC,
  out: "src/integrations/own/avoma/actions.json",
  skip: (_method, path) => (PAYLOADS.test(path) ? "the shape of a webhook delivery, not a call" : undefined),
  // the organization's webhook signing secret
  secrets: ["get_webhook_signing_secret"],
  params: {
    uuid: "The item's uuid, from the matching list action",
    meeting_uuid: "The meeting's uuid; list_meetings gives it",
    user_uuid: "The user's uuid; list_users gives it",
    external_id: "The call's id in the phone system it came from (the external_id it was created with)",
  },
} satisfies AppConfig;

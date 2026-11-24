// MeetGeek telling us the moment a meeting's analysis is done (or failed), at /webhooks/app/meetgeek/<connection>/<token>.
// MeetGeek has no API for webhooks: the owner pastes that address once on its Integrations page → Public API, which is
// what get_webhook_setup hands them. The <token> in the address is an HMAC of ENCRYPTION_KEY and the connection (worked
// out, never stored, only ever shown to the owner), so nobody else can post to it. MeetGeek's own X-MG-Signature is
// made with a secret set on MeetGeek's side that we never see, so the token is the check.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ActionDetail } from "@emplio/shared";
import { AppsError } from "../../types";
import type { Delivery, WebhookEvent } from "../index";
import { type Api, call } from "../openapi";

const SETUP = "Needs the webhook address pasted into MeetGeek once (Integrations → Public API → Webhook URL): run meetgeek.get_webhook_setup for it. Until then this never fires";

export const triggers: Record<string, { description: string; config: ActionDetail["input"]; output: ActionDetail["input"] }> = {
  meeting_analyzed: {
    description: `MeetGeek finished a meeting's notes: a recorded call, or a recording sent with upload_recording. The event has the meeting, its summary and highlights. ${SETUP}.`,
    config: [],
    output: [
      { name: "meeting_id", type: "string", required: true, description: "The meeting's id; get_transcript, get_insights and download_recording take it" },
      { name: "meeting", type: "object", required: false, description: "The meeting: title, host_email, participant_emails, timestamp_start_utc, timestamp_end_utc, join_link, language, template, team_ids" },
      { name: "summary", type: "string", required: false, description: "MeetGeek's summary of the meeting" },
      { name: "ai_insights", type: "string", required: false, description: "MeetGeek's notes on how the meeting went" },
      { name: "highlights", type: "object[]", required: false, description: "Key moments: label (Task, Decision...) and highlightText" },
    ],
  },
  analysis_failed: {
    description: `MeetGeek couldn't analyse a recording (one sent with upload_recording, usually). ${SETUP}.`,
    config: [],
    output: [{ name: "message", type: "string", required: true, description: "What MeetGeek said" }],
  },
};
// trigger → MeetGeek's message
export const events: Record<string, string> = { meeting_analyzed: "File analyzed successfully", analysis_failed: "File analyzed failed" };

export function hookToken(connection: string) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY isn't set");
  return createHmac("sha256", key).update(`meetgeek-webhook:${connection}`).digest("hex").slice(0, 32);
}
const hookUrl = (connection: string) => `${process.env.WEBHOOK_URL}/webhooks/app/meetgeek/${connection}/${hookToken(connection)}`;

export function webhookSetup(connection?: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive MeetGeek's events (WEBHOOK_URL isn't set)");
  if (!connection) throw new AppsError("connect MeetGeek first: emplio apps connect meetgeek");
  return {
    where: "MeetGeek → Integrations (app.meetgeek.ai/integrations) → Public API → Webhook URL, then Save",
    webhook_url: hookUrl(connection),
    note: "MeetGeek takes one address per account, so this replaces any other there. Keep it private: it works like a password. Emplio's meeting_analyzed and analysis_failed triggers stay quiet until it's saved; the polled new_meeting trigger works without it.",
  };
}

export async function watch(connection: string) {
  if (!process.env.WEBHOOK_URL) throw new AppsError("this server can't receive MeetGeek's events (WEBHOOK_URL isn't set)");
  return `meetgeek:${connection}`;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const get = (api: Api, key: string, path: string, meetingId: string) => call(api, key, { method: "GET", path, query: [], headers: [] }, { meetingId }).catch(() => undefined);

export async function receive(api: Api, delivery: Delivery, key: string) {
  if (!same(delivery.rest.split("/")[0] ?? "", hookToken(delivery.connection))) return null;
  const body = JSON.parse(delivery.body || "{}") as { message?: string; meeting_id?: string };
  return {
    events: async (): Promise<WebhookEvent[]> => {
      if (body.meeting_id) {
        // the webhook only names the meeting; what an automation needs is fetched now (each part may be missing)
        const [meeting, summary, highlights] = (await Promise.all([
          get(api, key, "/v1/meetings/{meetingId}", body.meeting_id),
          get(api, key, "/v1/meetings/{meetingId}/summary", body.meeting_id),
          get(api, key, "/v1/meetings/{meetingId}/highlights", body.meeting_id),
        ])) as [unknown, { summary?: string; ai_insights?: string } | undefined, { highlights?: unknown[] } | undefined];
        const data = { meeting_id: body.meeting_id, meeting, summary: summary?.summary, ai_insights: summary?.ai_insights, highlights: highlights?.highlights };
        return [{ id: `meetgeek:${delivery.connection}:${body.meeting_id}`, triggers: ["meeting_analyzed"], data }];
      }
      return /fail/i.test(body.message ?? "") ? [{ triggers: ["analysis_failed"], data: { message: body.message } }] : [];
    },
  };
}

// Talking to LiveKit. Every server API call is Twirp: POST <project>/twirp/livekit.<Service>/<Method> with a
// protobuf-JSON body (snake_case names are accepted) and a short-lived JWT we sign with the project's secret,
// carrying only the grants that one call needs. Cloud agents live on agents.<domain> instead of the project host.
import { createHmac } from "node:crypto";
import { z } from "zod";
import { AppsError } from "../../types";
import type { OwnAction } from "../index";
import { call, type Api } from "../openapi";

export const KEY_HELP = "cloud.livekit.io → Settings → Keys";

export type Project = { url: string; http: string; apiKey: string; secret: string };

// the key is pasted as one line: "<project url> <API key> <API secret>"
export function parseKey(key: string): Project {
  const parts = key.trim().split(/\s+/);
  const bad = (why: string) =>
    new AppsError(`${why}. Enter the project URL (like wss://myproj.livekit.cloud), the API key and the API secret (${KEY_HELP})`);
  if (parts.length !== 3) throw bad(`expected 3 parts, got ${parts.length}`);
  const [url, apiKey, secret] = parts as [string, string, string];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw bad(`"${url}" isn't a URL`);
  }
  if (!["wss:", "ws:", "https:", "http:"].includes(u.protocol)) throw bad(`"${url}" should start with wss://`);
  const http = `${u.protocol.replace(/^ws/, "http")}//${u.host}`;
  return { url: `${u.protocol.replace(/^http/, "ws")}//${u.host}`, http, apiKey, secret };
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

// HS256, as every LiveKit SDK signs; iss is the API key
export function sign(p: Project, claims: Record<string, unknown>, ttlSeconds = 600) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ ...claims, iss: p.apiKey, nbf: now, exp: now + ttlSeconds }));
  return `${head}.${body}.${createHmac("sha256", p.secret).update(`${head}.${body}`).digest("base64url")}`;
}

// what a call's token carries: video (room…), sip (admin/call) and agent (admin) grants
export type Grants = { video?: Record<string, unknown>; sip?: Record<string, boolean>; agent?: Record<string, boolean> };

// the Go SDK's rule: https://myproj.livekit.cloud → https://agents.livekit.cloud
const agentsHost = (http: string) => http.replace(/^https?:\/\/[^.]+\./, "https://agents.");

// one rpc as an action. grants come from the input (room-scoped ones need the room); body reshapes the input
// when the wire format differs (bytes go as base64). The whole body is always sent, `{}` included, since Twirp
// won't take an empty request.
export function twirp(
  service: string,
  method: string,
  description: string,
  input: z.ZodObject,
  grants: Grants | ((i: any) => Grants),
  opts: { readOnly?: boolean; agents?: boolean; body?: (i: any) => Record<string, unknown> } = {},
): OwnAction {
  return {
    description,
    input,
    readOnly: opts.readOnly,
    run: async (i: Record<string, unknown>, key: string) => {
      const p = parseKey(key);
      const g = typeof grants === "function" ? grants(i) : grants;
      const api: Api = {
        name: "LiveKit",
        base: opts.agents ? agentsHost(p.http) : p.http,
        tokenHelp: KEY_HELP,
        auth: () => ({ Authorization: `Bearer ${sign(p, g)}` }),
      };
      const body = opts.body ? opts.body(i) : i;
      const fields = Object.keys(body).filter((k) => body[k] !== undefined).map((k): [string, string] => [k, k]);
      return call(api, key, { method: "POST", path: `/twirp/livekit.${service}/${method}`, query: [], headers: [], body: { kind: "fields", fields } }, body);
    },
  };
}

// grant shorthands, as the server SDKs use them
export const roomAdmin = (room: unknown) => ({ video: { roomAdmin: true, room } });

// ── shared params
export const room = z.string().min(1).describe("The room's name (livekit.list_rooms shows them)");
export const identity = z.string().min(1).describe("The participant's identity, the unique id they joined with (livekit.list_participants shows them)");
export const metadata = z.string().describe("Free text kept with it, often JSON; apps read it, LiveKit doesn't");
export const attributes = z.record(z.string(), z.string()).describe('Key/value text pairs, e.g. {"customer_id": "42"}');
export const duration = (what: string) => z.string().describe(`${what}, as seconds with an s, e.g. "30s" or "3600s"`);
export const pageToken = z.object({ token: z.string() }).describe("next_page_token from the previous answer, to get the next page");
export const agentDispatch = z
  .object({
    agent_name: z.string().describe("The agent's name, as it registered with LiveKit (livekit.list_agents shows cloud agents)"),
    metadata: z.string().optional().describe("Text handed to the agent for this job, often JSON"),
    attributes: attributes.optional(),
    deployment: z.string().optional().describe("Cloud agents only: which deployment of the agent to use"),
    restart_policy: z.enum(["JRP_ON_FAILURE", "JRP_NEVER"]).optional().describe("Cloud only: restart the agent's job if it fails (JRP_ON_FAILURE, the default) or not (JRP_NEVER)"),
  })
  .loose();
export const sipPage = z
  .object({ after_id: z.string().optional().describe("Only those whose id comes after this one (the last id of the previous page)"), limit: z.number().int().optional().describe("How many at most") })
  .describe("Paging");

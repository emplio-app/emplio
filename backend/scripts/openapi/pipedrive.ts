// Pipedrive: what the generator (../openapi-actions.ts) can't tell from the spec. Two specs: API v2 first (the app's
// base), then v1 for everything v2 doesn't have yet. Where both have a call, v2's is kept.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const V1 = "https://developers.pipedrive.com/docs/api/v1/openapi.yaml";
const V2 = "https://developers.pipedrive.com/docs/api/v2/openapi.yaml";
type Schema = Record<string, any>;
const METHODS = ["get", "post", "put", "patch", "delete"];
const calls = async (url: string) => {
  const spec = Bun.YAML.parse(await (await fetch(url)).text()) as Schema;
  return Object.entries<Schema>(spec.paths).flatMap(([path, ops]) =>
    Object.entries<Schema>(ops).filter(([m]) => METHODS.includes(m)).map(([m, op]) => ({ call: `${m.toUpperCase()} ${path}`, id: op.operationId as string })),
  );
};
const [v1, v2] = await Promise.all([calls(V1), calls(V2)]);
const v2Calls = new Set(v2.map((c) => c.call));
const v2Ids = new Set(v2.map((c) => c.id));
// v1 calls that v2 replaces: the same path, or the same operation under v2's new path
const replaced = new Set(v1.filter((c) => v2Calls.has(c.call) || v2Ids.has(c.id)).map((c) => c.call));
const seen = new Set<string>();

const SKIP: Record<string, string> = {
  "GET /oauth/authorize": "sign-in for Marketplace apps; Emplio connects with an API token",
  "POST /oauth/token": "sign-in for Marketplace apps; Emplio connects with an API token",
  "POST /oauth/token/": "sign-in for Marketplace apps; Emplio connects with an API token",
  "POST /meetings/userProviderLinks": "only a Marketplace video-call app can call it",
  "DELETE /meetings/userProviderLinks/{id}": "only a Marketplace video-call app can call it",
};

export default {
  spec: [V2, V1],
  out: "src/integrations/own/pipedrive/actions.json",
  name: namer(await composioNames("pipedrive")),
  // v2 is read first, so a call both specs have is v1's the second time it's seen
  skip: (method, path) => {
    const call = `${method} ${path}`;
    if (SKIP[call]) return SKIP[call];
    const again = seen.has(call);
    seen.add(call);
    if (replaced.has(call) && (again || !v2Calls.has(call))) return "API v2 has the same call";
  },
  // GET /webhooks answers with each webhook's basic-auth password
  secrets: ["get_all_webhooks"],
} satisfies AppConfig;

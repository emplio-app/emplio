// GitHub: what the generator (../openapi-actions.ts) can't tell from the spec.
import type { AppConfig } from "../openapi-actions";

// Named from the operation's summary ("Get a tree" → get_a_tree), the names skills already use. A summary used
// twice keeps GitHub's operation id on the later one.
const seen = new Set<string>();
const name: AppConfig["name"] = (id, _method, _path, op) => {
  const base = String(op.summary ?? id).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (seen.has(base)) return `${base}_${id}`;
  seen.add(base);
  return base;
};

export default {
  spec: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
  out: "src/integrations/own/github/actions.json",
  name,
  // these only answer to a GitHub App or an enterprise's own login, never to a person's token
  skip: (_method, path) =>
    /^\/(app|app-manifests|applications|enterprises|enterprise|marketplace_listing|scim)(\/|$)/.test(path) ? "needs a GitHub App or enterprise login" : undefined,
} satisfies AppConfig;

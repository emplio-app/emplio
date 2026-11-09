// Stripe: what the generator (../openapi-actions.ts) can't tell from the spec.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const EVENTS = new URL("../../src/integrations/own/stripe/events.json", import.meta.url).pathname;

export default {
  spec: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
  out: "src/integrations/own/stripe/actions.json",
  name: namer(await composioNames("stripe")),
  // `expand` is on every call and swaps ids for whole objects; the plain object is what an agent needs, and the cost of a wrong one is a huge answer
  drop: { "*": ["expand"] },
  secrets: ["find_secret", "list_secrets"],
  reads: ["create_preview_invoice"],
  // everything Stripe can report, for triggers.ts
  after: async (spec) => {
    const body = spec.paths["/v1/webhook_endpoints"].post.requestBody.content["application/x-www-form-urlencoded"].schema;
    await Bun.write(EVENTS, JSON.stringify({ version: spec.info.version, events: body.properties.enabled_events.items.enum.filter((e: string) => e !== "*") }));
  },
} satisfies AppConfig;

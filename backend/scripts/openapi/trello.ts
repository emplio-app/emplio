// Trello: what the generator (../openapi-actions.ts) can't tell from the spec.
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const OUT = "src/integrations/own/trello/actions.json";
type Schema = Record<string, any>;

const theirs = await composioNames("trello");
const fallback = namer(theirs);
// Composio's Trello names are its old path-based ones: GET /boards/{id}/cards/{idCard} → get_boards_cards_by_id_board_by_id_card
const ONE: Record<string, string> = { boards: "board", cards: "card", organizations: "org", members: "member", actions: "action", checklists: "checklist", labels: "label", lists: "list", notifications: "notification", webhooks: "webhook", tokens: "token" };
const VERB: Record<string, string> = { GET: "get", POST: "add", PUT: "update", DELETE: "delete" };
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const pathName = (method: string, path: string) => {
  const parts = path.split("/").filter(Boolean);
  const words: string[] = [];
  const by: string[] = [];
  parts.forEach((p, i) => {
    const param = /^\$?\{(\w+)\}$/.exec(p)?.[1];
    if (!param) return void words.push(snake(p));
    by.push(param === "id" ? `id_${ONE[parts[i - 1]!] ?? snake(parts[i - 1]!)}` : snake(param));
  });
  return [VERB[method], ...words, ...by.map((b) => `by_${b}`)].join("_");
};
const taken = new Set<string>();
const name: AppConfig["name"] = (id, method, path, op) => {
  const guess = pathName(method, path);
  const hit = theirs.find((n) => n === guess || (n.length >= 50 && guess.startsWith(n)));
  if (hit && !taken.has(hit)) return taken.add(hit), hit;
  return fallback(id, method, path, op);
};

export default {
  spec: "https://developer.atlassian.com/cloud/trello/swagger.v3.json",
  out: OUT,
  name,
  after: async () => {
    const file = new URL(`../../${OUT}`, import.meta.url).pathname;
    const out = await Bun.file(file).json();
    for (const a of out.actions) {
      // a typo in the spec: /enterprises/${id}/...
      a.send.path = a.send.path.replace("${", "{");
      // the connection's own token and key: filled in by own/trello/index.ts, never typed by an agent
      const fill = ["token", "key"].filter((p) => a.send.path.includes(`{${p}}`));
      for (const p of fill) {
        delete a.input.properties[p];
        a.input.required = a.input.required?.filter((r: string) => r !== p);
      }
      if (fill.length) a.fill = fill;
      if (!a.input.required?.length) delete a.input.required;
      // the spec says these are organization ids, but describes them as whole organizations
      const orgs = a.input.properties.idOrganizations;
      if (orgs) a.input.properties.idOrganizations = { type: "array", items: { type: "string" }, description: orgs.description };
      // the spec lists uploads as query params; Trello takes the file as multipart
      for (const [k, v] of Object.entries<Schema>(a.input.properties)) {
        if (!/^(file|fileSource)$/.test(k) || !a.send.query.includes(k)) continue;
        a.send.query = a.send.query.filter((q: string) => q !== k);
        a.send.body = { kind: "form", fields: [[k, k]] };
        a.input.properties[k] = { description: `${v.description ? `${v.description} ` : ""}A file from the computer: {"file": "/work/..."}` };
      }
    }
    await Bun.write(file, JSON.stringify(out));
  },
} satisfies AppConfig;

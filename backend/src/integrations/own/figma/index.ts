// Figma on a personal access token: every call of Figma's REST API a personal token may make (actions.json, generated
// by `bun scripts/openapi-actions.ts figma` from github.com/figma/rest-api-spec), plus download_figma_images, which hands
// back rendered layers as files. Comments, versions, edits, library publishes and Dev Mode changes start automations by
// webhook (triggers.ts); new folders and changed files in a folder are polled (polls/figma.ts).
import { z } from "zod";
import { AppFile, AppsError } from "../../types";
import type { OwnAction, OwnApp } from "../index";
import { type Api, call, specActions } from "../openapi";
import { events, receive, triggers, unwatch, wanted, watch } from "./triggers";

const TOKEN_HELP = "Figma → Settings → Security → Personal access tokens";
export const api: Api = {
  name: "Figma",
  base: "https://api.figma.com",
  tokenHelp: TOKEN_HELP,
  auth: (key) => ({ "X-Figma-Token": key }),
  // a wrong or expired token is a 403 "Invalid token" (or "Token expired"), not a 401
  deadToken: (status, body) => status === 401 || (status === 403 && /invalid token|token expired|expired token/i.test(String(body?.err ?? body?.message ?? body))),
};

const RENDER = { method: "GET", path: "/v1/images/{file_key}", query: ["ids", "scale", "format", "version", "contents_only", "use_absolute_bounds"], headers: [] };
const EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml", pdf: "application/pdf" };

// ponytail: fetches every rendered layer into memory at once; fine for a handful, page through ids if people ask for hundreds
const download_figma_images: OwnAction = {
  description: "Download layers of a Figma file (frames, components, any node) as image files: PNG, JPG, SVG or PDF. Answers each layer's file. render_images_of_file_nodes gives links instead.",
  readOnly: true,
  input: z.object({
    file_key: z.string().describe("The file's key: in its link, the part after /design/ or /file/ (figma.com/design/AbC123xyz/Homepage → AbC123xyz)"),
    ids: z.array(z.string()).min(1).describe('The layers\' node ids, like "1:2". In a link they\'re the node-id parameter with - for : (node-id=1-2 → "1:2"); get_file_json lists them'),
    format: z.enum(["png", "jpg", "svg", "pdf"]).default("png").describe("The file type"),
    scale: z.number().min(0.01).max(4).optional().describe("Size multiplier, 0.01 to 4 (PNG and JPG); 2 for retina"),
    version: z.string().optional().describe("A version id from get_versions_of_a_file, for how it looked then; leave out for now"),
  }),
  run: async (i, key) => {
    const { images, err } = (await call(api, key, RENDER, { ...i, ids: i.ids.join(",") })) as { images?: Record<string, string | null>; err?: string | null };
    if (err) throw new AppsError(`Figma: ${err}`);
    return {
      images: await Promise.all(
        Object.entries(images ?? {}).map(async ([id, url]) => {
          if (!url) return { id, error: "Figma couldn't render this layer (no such node, or nothing visible in it)" };
          const res = await fetch(url);
          if (!res.ok) return { id, error: `downloading it failed (${res.status})` };
          return { id, file: new AppFile(`${id.replace(/[^\w-]/g, "-")}.${i.format}`, EXT[i.format]!, new Uint8Array(await res.arrayBuffer())) };
        }),
      ),
    };
  },
};

const ME = { method: "GET", path: "/v1/me", query: [], headers: [] };

export const figma: OwnApp = {
  app: "figma",
  name: "Figma",
  logo: "/logos/figma.svg",
  keyField: {
    label: "Personal access token",
    help: `In Figma, open ${TOKEN_HELP} and click Generate new token. Pick the longest expiry Figma offers and give it every scope, with write access where there's a choice (Emplio needs webhooks:write to start automations). Figma shows the token once, so copy it straight away. When it expires, make a new one and reconnect.`,
    placeholder: "figd_...",
  },
  async check(key) {
    const me = (await call(api, key, ME, {})) as { handle?: string; email?: string };
    return me.email && me.handle ? `${me.handle} (${me.email})` : me.handle || me.email || "Figma";
  },
  push: {
    events,
    triggers,
    start: (key, connection, event, config) => watch(api, key, connection, event, config),
    stop: (key, id) => unwatch(api, key, id),
    receive,
    wanted,
  },
  actions: { ...(await specActions(new URL("./actions.json", import.meta.url), api)), download_figma_images },
};

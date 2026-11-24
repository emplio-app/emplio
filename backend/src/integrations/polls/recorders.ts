// New recordings on Plaud and NeoSapien. Both connect through the maker's own MCP server, which sends no webhooks,
// so they're polled. A tool answers in text: the JSON in it is read, and the first list of objects is the recordings.
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

type Row = Record<string, unknown>;

// the JSON inside a tool's text (Plaud wraps it in an "untrusted data" block), or null
export function jsonIn(text: unknown): unknown {
  if (typeof text !== "string") return text;
  const s = text.search(/[[{]/);
  const e = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (s < 0 || e < s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1));
  } catch {
    return null;
  }
}

// the first array of objects, looking a few levels down ({data: [...]}, {conversations: [...]}, ...)
export function rowsIn(v: unknown, depth = 0): Row[] {
  if (Array.isArray(v)) return v.every((x) => x && typeof x === "object" && !Array.isArray(x)) && v.length ? (v as Row[]) : [];
  if (!v || typeof v !== "object" || depth > 3) return [];
  for (const x of Object.values(v)) {
    const got = rowsIn(x, depth + 1);
    if (got.length) return got;
  }
  return [];
}

const pick = (r: Row, keys: string[]) => keys.map((k) => r[k]).find((x) => typeof x === "string" || typeof x === "number");
const idOf = (r: Row) => pick(r, ["id", "file_id", "conversation_id", "memory_id", "recording_id", "uuid", "_id"]);
const whenOf = (r: Row) => {
  const t = pick(r, ["created_at", "createdAt", "start_time", "started_at", "startTime", "recorded_at", "date", "updated_at"]);
  // seconds or milliseconds since 1970, or a date string
  return typeof t === "number" ? new Date(t < 1e12 ? t * 1000 : t).toISOString() : t;
};

// what's there now: recent rows with an id. A row with no date is kept; the seen list stops it firing twice.
export const fresh = (text: unknown) =>
  rowsIn(jsonIn(text))
    .filter((r) => idOf(r) !== undefined && (whenOf(r) === undefined || recent(whenOf(r))))
    .map((r) => ({ id: String(idOf(r)), item: { recording: r } }));

const every = { every: 15, min: 5 };

export const plaud: Record<string, PollTrigger> = {
  new_recording: {
    description:
      "A new recording appears in Plaud (checked every 15 minutes). Read its summary and action items with plaud.get_note and its transcript with plaud.get_transcript.",
    config: z.object({}),
    output: [{ name: "recording", type: "object", required: true, description: "The Plaud recording as listed: id, name, created_at, duration (milliseconds)" }],
    ...every,
    // ponytail: the newest 50 recordings; more than that made between two checks are missed
    poll: async (_c, run) => fresh(await run("plaud.list_files", { page: 1, page_size: 50 })),
  },
};

// NeoSapien doesn't publish its tool names, so the listing tool is found by name among the server's read-only tools
const NEO = /(list|recent|search).*(conversation|memor|recording)|(conversation|memor|recording).*(list|recent)/i;
export async function neoListTool() {
  const { APPS } = await import("../own/index");
  const tools = (await APPS.neosapien?.mcp?.tools()) ?? [];
  const t = tools.find((x) => x.readOnly && NEO.test(x.name)) ?? tools.find((x) => NEO.test(x.name));
  if (!t) throw new Error("NeoSapien lists no tool for recent conversations yet");
  return t.name;
}

export const neosapien: Record<string, PollTrigger> = {
  new_conversation: {
    description:
      "A new conversation is recorded on NeoSapien, from Neo 1 or the desktop app (checked every 15 minutes). Read its transcript and notes with NeoSapien's other tools.",
    config: z.object({}),
    output: [{ name: "recording", type: "object", required: true, description: "The NeoSapien conversation as listed: its id, title, time and summary when given" }],
    ...every,
    poll: async (_c, run: Run) => fresh(await run(`neosapien.${await neoListTool()}`, {})),
  },
};

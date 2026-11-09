// Slack by sign-in only. A login holds two tokens, bot|user: actions use the bot (posts appear as Emplio, reads need it in
// the channel) unless Slack gives bots no way in (search, reminders, stars...). actions.json is generated from Slack's docs
// by `bun scripts/openapi/slack.ts`; everything else Slack reports starts automations through its Events API (triggers.ts).
import { z } from "zod";
import { AppFile, AppsError } from "../../types";
import type { OwnAction, OwnApp } from "../index";
import { type Api, call } from "../openapi";
import { events, receive, triggers, wanted, watchId } from "./triggers";

// what Slack's docs ask for, per method; scopes that are alternatives to these (channels:write.topic...) are left out
const BOT_SCOPES = "bookmarks:read,bookmarks:write,calls:read,calls:write,canvases:read,canvases:write,channels:history,channels:join,channels:manage,channels:read,chat:write,chat:write.public,conversations.connect:manage,conversations.connect:write,dnd:read,emoji:read,files:read,files:write,groups:history,groups:read,groups:write,im:history,im:read,im:write,links:write,lists:read,lists:write,mpim:history,mpim:read,mpim:write,pins:read,pins:write,reactions:read,reactions:write,remote_files:read,remote_files:share,remote_files:write,team.billing:read,team.preferences:read,team:read,usergroups:read,usergroups:write,users.profile:read,users:read,users:read.email,users:write";
const USER_SCOPES = "dnd:write,files:write,reminders:read,reminders:write,search:read,stars:read,stars:write,users.profile:write,users:write";

const DEAD = new Set(["invalid_auth", "token_revoked", "account_inactive", "token_expired"]);
const RECONNECT = "Slack says this connection no longer works; connect Slack again";

type SlackError = { ok?: boolean; error?: string; needed?: string; response_metadata?: { messages?: string[] } };
const api: Api = {
  name: "Slack",
  base: "https://slack.com/api",
  tokenHelp: "connect Slack again from Emplio",
  // Slack answers almost every failure with a 200 and {ok: false}
  failed: (out: SlackError) => {
    if (out.ok !== false) return;
    if (DEAD.has(out.error ?? "")) throw new AppsError(RECONNECT, true);
    if (out.error === "missing_scope") return `this needs a Slack permission Emplio wasn't given (${out.needed}); connect Slack again`;
    if (out.error === "not_in_channel") return "Emplio isn't in that channel; invite it first with /invite @Emplio in Slack";
    return [out.error, ...(out.response_metadata?.messages ?? [])].join(": ");
  },
};

const tokens = (login: string) => {
  const [bot = "", user = ""] = login.split("|");
  return { bot, user };
};
const token = (login: string, kind: "bot" | "user") => {
  const t = tokens(login)[kind];
  if (!t) throw new AppsError("this needs a person's own Slack sign-in, which this connection doesn't have; connect Slack again and allow it");
  return t;
};

// Slack's form bodies carry anything that isn't plain text as JSON text; a file goes as multipart
const send = (method: string, input: Record<string, unknown>, tok: string) => {
  const fields = Object.keys(input).filter((k) => input[k] !== undefined);
  const hasFile = fields.some((k) => input[k] instanceof AppFile);
  const sent = Object.fromEntries(fields.map((k) => [k, input[k] && typeof input[k] === "object" && !(input[k] instanceof AppFile) ? JSON.stringify(input[k]) : input[k]]));
  return call(api, tok, { method: "POST", path: `/${method}`, query: [], headers: [], body: { kind: hasFile ? "form" : "urlencoded", fields: fields.map((k): [string, string] => [k, k]) } }, sent);
};

type Generated = { name: string; method: string; token: "bot" | "user"; description: string; readOnly: boolean; input: object };
const generated = ((await Bun.file(new URL("./actions.json", import.meta.url)).json()) as { actions: Generated[] }).actions;
const actions: Record<string, OwnAction> = Object.fromEntries(
  generated.map((a) => [
    a.name,
    {
      description: a.description,
      readOnly: a.readOnly,
      input: z.fromJSONSchema(a.input as z.core.JSONSchema.JSONSchema) as z.ZodObject,
      run: (i: Record<string, unknown>, login: string) => send(a.method, i, token(login, a.token)),
    },
  ]),
);

// ponytail: first 1000 of anything; a workspace past that uses the list actions with a cursor
const everything = async <T>(method: string, input: Record<string, unknown>, key: string, login: string) => {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const out = (await send(method, { ...input, limit: 200, cursor }, token(login, "bot"))) as Record<string, any>;
    items.push(...(out[key] as T[]));
    cursor = out.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return items;
};
const contains = (query: string, ...texts: (string | undefined)[]) => texts.some((t) => t?.toLowerCase().includes(query.toLowerCase()));

const extras: Record<string, OwnAction> = {
  upload_or_create_a_file_in_slack: {
    description: "Upload a file from the computer to Slack, and share it in a channel or thread if one is given. The file appears as posted by Emplio.",
    input: z.object({
      file: z.any().describe('The file: {"file": "/work/..."}'),
      channel_id: z.string().optional().describe("Channel to share it in: its ID, like C0123ABCDEF. Left out, it's uploaded but not shared."),
      thread_ts: z.string().optional().describe("Share it in this thread: the parent message's ts"),
      title: z.string().optional().describe("The file's title in Slack"),
      initial_comment: z.string().optional().describe("A message to post with the file"),
    }),
    run: async (input: { file: unknown; channel_id?: string; thread_ts?: string; title?: string; initial_comment?: string }, login: string) => {
      const file = input.file;
      if (!(file instanceof AppFile)) throw new AppsError('file: give the file as {"file": "/work/..."}');
      const bot = token(login, "bot");
      const up = (await send("files.getUploadURLExternal", { filename: file.name, length: file.bytes.length }, bot)) as { upload_url: string; file_id: string };
      const put = await fetch(up.upload_url, { method: "POST", body: file.bytes as Uint8Array<ArrayBuffer> });
      if (!put.ok) throw new AppsError(`Slack didn't take the file (${put.status})`);
      return send("files.completeUploadExternal", { files: [{ id: up.file_id, title: input.title ?? file.name }], channel_id: input.channel_id, thread_ts: input.thread_ts, initial_comment: input.initial_comment }, bot);
    },
  },
  download_slack_file: {
    description: "Download a file shared in Slack to the computer.",
    readOnly: true,
    input: z.object({ file: z.string().describe("The file's ID, like F0123ABCDEF (messages and list_files_with_filters_in_slack show it)") }),
    run: async (input: { file: string }, login: string) => {
      const bot = token(login, "bot");
      const { file } = (await send("files.info", { file: input.file }, bot)) as { file: { name: string; mimetype: string; url_private_download?: string; url_private?: string } };
      const url = file.url_private_download ?? file.url_private;
      if (!url) throw new AppsError("this Slack file has no download link");
      const res = await fetch(url, { headers: { Authorization: `Bearer ${bot}` } });
      // a token Slack doesn't accept for the file gets its sign-in page, as a 200
      if (!res.ok || res.headers.get("content-type")?.includes("text/html")) throw new AppsError("Slack wouldn't hand over that file; Emplio may need to be in the channel it was shared in");
      return new AppFile(file.name, file.mimetype, new Uint8Array(await res.arrayBuffer()));
    },
  },
  find_channels: {
    description: "Find Slack channels by words in their name, topic or purpose.",
    readOnly: true,
    input: z.object({ query: z.string().describe("Words to look for") }),
    run: async (input: { query: string }, login: string) => {
      type Channel = { id: string; name: string; is_private?: boolean; is_member?: boolean; num_members?: number; topic?: { value?: string }; purpose?: { value?: string } };
      const all = await everything<Channel>("conversations.list", { types: "public_channel,private_channel", exclude_archived: true }, "channels", login);
      return { channels: all.filter((c) => contains(input.query, c.name, c.topic?.value, c.purpose?.value)).slice(0, 50).map(({ id, name, is_private, is_member, num_members }) => ({ id, name, is_private, is_member, num_members })) };
    },
  },
  find_users: {
    description: "Find people in Slack by name, display name or email, or by their ID.",
    readOnly: true,
    input: z.object({ query: z.string().describe("A name, email or user ID") }),
    run: async (input: { query: string }, login: string) => {
      type User = { id: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean; profile?: { display_name?: string; email?: string } };
      const all = await everything<User>("users.list", {}, "members", login);
      return { users: all.filter((u) => u.id === input.query || contains(input.query, u.name, u.real_name, u.profile?.display_name, u.profile?.email)).slice(0, 50).map((u) => ({ id: u.id, name: u.real_name ?? u.name, display_name: u.profile?.display_name, email: u.profile?.email, is_bot: u.is_bot, deleted: u.deleted })) };
    },
  },
};

export const slack: OwnApp = {
  app: "slack",
  name: "Slack",
  logo: "/logos/slack.svg",
  async check(login) {
    return ((await send("auth.test", {}, tokens(login).bot)) as { team?: string }).team;
  },
  oauth: {
    ready: () => Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET),
    // Slack always shows its own consent page, so a link someone was sent can't finish by itself
    authorizeUrl: (redirect, state) =>
      `https://slack.com/oauth/v2/authorize?${new URLSearchParams({ client_id: process.env.SLACK_CLIENT_ID!, scope: BOT_SCOPES, user_scope: USER_SCOPES, redirect_uri: redirect, state })}`,
    // token rotation is off for this app, so these never run out
    exchange: async (code, redirect) => {
      const res = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: process.env.SLACK_CLIENT_ID!, client_secret: process.env.SLACK_CLIENT_SECRET!, code, redirect_uri: redirect }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
      const out = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; access_token?: string; authed_user?: { access_token?: string } } | null;
      if (!out?.ok || !out.access_token) throw new AppsError(`Slack didn't finish the sign-in${out?.error ? ` (${out.error})` : ""}. Try again.`);
      return `${out.access_token}|${out.authed_user?.access_token ?? ""}`;
    },
  },
  push: {
    events,
    triggers,
    appWide: true,
    async start(login) {
      if (!process.env.SLACK_SIGNING_SECRET) throw new AppsError("this server can't receive Slack's events (SLACK_SIGNING_SECRET isn't set)");
      const me = (await send("auth.test", {}, tokens(login).bot)) as { team_id: string };
      return watchId(me.team_id);
    },
    receive,
    wanted,
  },
  actions: { ...actions, ...extras },
};

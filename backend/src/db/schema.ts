import type { Approval, PlanStep, JobInfo } from "@emplio/shared";
import { sql, type SQL } from "drizzle-orm";
import { type AnyPgColumn, bigint, boolean, customType, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

// A message's searchable text: what was written, the commands run and what they printed. JSON escapes
// (\n, \") become spaces so they don't glue onto words.
export const messageText = (parts: SQL | ReturnType<typeof jsonb>): SQL =>
  sql`regexp_replace(jsonb_path_query_array(${parts}, '$[*] ? (@.type == "text").text')::text || ' ' || jsonb_path_query_array(${parts}, '$[*].input.command')::text || ' ' || jsonb_path_query_array(${parts}, '$[*].output.output')::text, '\\\\[nrt"]', ' ', 'g')`;

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  // null until the user finishes onboarding after verifying their email
  name: text(),
  // mobile number, digits only with the country code (919876543210): how channels recognise them
  phone: text().unique(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  // when they last sent a message, within 5 minutes. Kept by a database trigger on activity, for the console's list.
  lastActiveAt: timestamp({ withTimezone: true }),
}, (t) => [
  index().on(t.lastActiveAt.desc().nullsLast(), t.createdAt.desc()),
  index("users_name_sort_index").on(t.name),
  index().on(t.createdAt),
  index().using("gin", t.email.op("gin_trgm_ops")),
  index().using("gin", t.name.op("gin_trgm_ops")),
  index().using("gin", t.phone.op("gin_trgm_ops")),
]);

export const workspaces = pgTable("workspaces", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  // the business's own SQL database (database.ts): its libsql:// URL, or file: for a local file; null until first used
  dataDb: text(),
  // who may use a table there, where someone decided (lowercase name → setting); the rest go by name (database.ts)
  dbAccess: jsonb().$type<Record<string, "private" | "staff">>().notNull().default({}),
  // only the settings this business changed (settings.ts); the rest are defaults
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  // check-ins (heartbeat.ts): the chat they write in, and when the last one ran
  heartbeatChatId: uuid(),
  heartbeatAt: timestamp({ withTimezone: true }),
  // when the last end-of-day report ran (heartbeat.ts)
  reportAt: timestamp({ withTimezone: true }),
  // day-one setup (setup.ts): when the agent first offered it, and when it was finished or skipped
  setupOfferedAt: timestamp({ withTimezone: true }),
  setupDoneAt: timestamp({ withTimezone: true }),
  setupSkippedAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  // when someone last sent a message, within 5 minutes. Kept by a database trigger on activity, for the console's list.
  lastActiveAt: timestamp({ withTimezone: true }),
}, (t) => [
  index().on(t.lastActiveAt.desc().nullsLast(), t.createdAt.desc()),
  index("workspaces_name_sort_index").on(t.name),
  index().on(t.createdAt),
  index().using("gin", t.name.op("gin_trgm_ops")),
]);

export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    role: memberRole().notNull().default("member"),
    // who they report to (optional; another member's user id): sees their tasks and is told when one runs late
    reportsTo: uuid().references(() => users.id, { onDelete: "set null" }),
    // app actions this person said "Always allow" to (gmail.send_email): the agent runs them without asking
    alwaysAllowed: text().array().notNull().default([]),
    // their saved browser logins in this business: a profile at the browser service, made on first use (browser-host.ts)
    browserProfileId: text(),
    // encrypted copy of that browser's cookies, local storage and Indexed DB (browser.ts), so logins survive a provider change
    browserState: text(),
    // their own morning brief (heartbeat.ts; the owner's is the day's first check-in): when the last one ran,
    // and the web chat it goes in when they haven't connected a phone
    briefAt: timestamp({ withTimezone: true }),
    // and their own end-of-day report, at the business's report hour
    reportAt: timestamp({ withTimezone: true }),
    // ponytail: replaced by mainChatId (kept until the next migration drops it)
    briefChatId: uuid(),
    // their one ongoing conversation in this business: the same on the web and their channels, and
    // where background work (check-ins, tasks, automations) reports back; made on first use
    mainChatId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index().on(t.userId)],
);

// One sign-in code per email, replaced on each ask. Only its hash is kept.
export const loginCodes = pgTable("login_codes", {
  email: text().primaryKey(),
  codeHash: text().notNull(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  tries: integer().notNull().default(0),
});

export const sessions = pgTable("sessions", {
  // sha256 of the cookie token, so a DB leak doesn't leak live sessions
  tokenHash: text().primaryKey(),
  userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
  // the business this sign-in has open in the web app; unset: their first
  workspaceId: uuid().references(() => workspaces.id, { onDelete: "set null" }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// An iPhone that takes notifications, for as long as that sign-in lasts (push.ts).
export const pushDevices = pgTable("push_devices", {
  token: text().primaryKey(),
  sessionHash: text().notNull().references(() => sessions.tokenHash, { onDelete: "cascade" }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [index().on(t.sessionHash)]);

// A browser that takes notifications (webpush.ts), for as long as that sign-in lasts.
export const webPushDevices = pgTable("web_push_devices", {
  endpoint: text().primaryKey(),
  sessionHash: text().notNull().references(() => sessions.tokenHash, { onDelete: "cascade" }),
  p256dh: text().notNull(),
  auth: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [index().on(t.sessionHash)]);

// A computer running the Emplio desktop app, signed in as this person (devices.ts). While it's awake and connected,
// their commands and browser run on it instead of in the cloud. The app proves itself with a token we keep only the hash of.
export const devices = pgTable("devices", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
  // made by the app on its first run, so signing in again on the same computer is the same device
  installId: text().notNull(),
  name: text().notNull(),
  platform: text().notNull(),
  tokenHash: text().notNull(),
  lastSeenAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex().on(t.userId, t.installId), index().on(t.tokenHash)]);

export const conversations = pgTable(
  "conversations",
  {
    // generated by the client (useChat id) so a new chat has a URL before the first reply
    id: uuid().primaryKey(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text().notNull(),
    // Notes standing in for the oldest messages once the chat outgrew what's sent to the model (see
    // compact.ts). Only what the model sees changes: every message is still stored and shown.
    // summaryUpto: the last message the notes cover; later ones are sent as they are.
    summary: text(),
    summaryUpto: text(),
    // the size of the last request for this chat, as the provider counted it; null until measured
    contextTokens: integer(),
    // a reply finished while nobody had the chat open; cleared when it's opened
    unread: boolean().notNull().default(false),
    // reader.ts: when it's due a read (the chat quiet for a while), and the last message read so far
    readDueAt: timestamp({ withTimezone: true }),
    readAt: timestamp({ withTimezone: true }),
    // where the person talks in it: the web app, or a channel (channels/)
    channel: text({ enum: ["web", "telegram"] }).notNull().default("web"),
    // where they last wrote from, which matters in a main chat (it's on both): what finishes later goes only there
    wroteFrom: text({ enum: ["web", "telegram"] }).notNull().default("web"),
    // main: the person's main chat; background: a check-in, task or automation working on its own,
    // whose result is posted to the main chat; chat: one the person started
    // job: a job's own chat (jobs.ts), opened from its line in the chat that started it
    kind: text({ enum: ["chat", "main", "background", "job"] }).notNull().default("chat"),
    // archived (out of the sidebar's list, nothing deleted) until anything new happens in it: archived while
    // archivedAt is at or after updatedAt, so a new message brings it back with no extra step
    archivedAt: timestamp({ withTimezone: true }),
    // the newest message of the version of the chat shown now; editing a message forks the chat (chat.ts loadMessages)
    headId: text(),
    // the checklist the agent keeps for a job of several steps (plan.ts)
    plan: jsonb().$type<PlanStep[]>(),
    // when this chat's browser last ran, and the page it was on when it stopped (encrypted): what its Live browser
    // button reopens (browser.ts)
    browserUsedAt: timestamp({ withTimezone: true }),
    browserPage: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.workspaceId, t.updatedAt), index().on(t.workspaceId, t.updatedAt)],
);

// Someone reachable on a channel (one Telegram bot / WhatsApp number / phone number for the whole
// product): who they are, the business they're talking to now (last used, /switch) and their running thread.
export const channelLinks = pgTable(
  "channel_links",
  {
    channel: text({ enum: ["telegram"] }).notNull(),
    // the channel's id for them: a Telegram chat id, later a phone number
    address: text().notNull(),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    // ponytail: no longer used (they talk in their main chat, mainChatId); dropped with briefChatId later
    conversationId: uuid().references(() => conversations.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.channel, t.address] }), index().on(t.userId)],
);

export const messages = pgTable(
  "messages",
  {
    // AI SDK UIMessage id
    id: text().primaryKey(),
    conversationId: uuid().notNull().references(() => conversations.id, { onDelete: "cascade" }),
    role: text({ enum: ["system", "user", "assistant"] }).notNull(),
    parts: jsonb().notNull(),
    // the message it follows; null for the first. Two with the same parent are two versions of that spot (an edit)
    parentId: text(),
    createdAt: timestamp({ withTimezone: true, precision: 6 }).notNull().defaultNow(),
    // for searching old chats (search.ts); 'simple': no stemming, so names and Hindi words match as typed
    search: tsvector().generatedAlwaysAs((): SQL => sql`to_tsvector('simple', ${messageText(sql`parts`)})`),
  },
  (t) => [index().on(t.conversationId, t.createdAt), index().using("gin", t.search)],
);

// A person's sign-in to an outside app (Gmail, Zoho, ...). Ours: the provider holding the
// actual login (Composio today, our own later) is only referenced, so it can be swapped.
export const connections = pgTable(
  "connections",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    // our app name, e.g. "gmail"
    app: text().notNull(),
    provider: text().notNull(),
    // the provider's id for this sign-in (Composio connected account; ours: the connection's own)
    externalId: text().notNull(),
    status: text({ enum: ["pending", "active", "expired", "failed"] }).notNull().default("pending"),
    // which account it is, to tell several of one app apart: filled from the account (the Gmail address)
    // once signed in, renamable; null until then (shown as the app's name)
    label: text(),
    // a login we hold ourselves (an API key), encrypted (see secrets.ts); null when the provider holds it
    secret: text(),
    // own OAuth, for apps whose logins run out: how to get a new one (encrypted like `secret`), and when this one ends
    refreshToken: text(),
    expiresAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  // a person can connect several accounts of one app (work and personal Gmail)
  (t) => [index().on(t.workspaceId, t.userId, t.app)],
);

// Every app action run, by whom and from where: the audit trail.
export const actionRuns = pgTable(
  "action_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid().references(() => conversations.id, { onDelete: "set null" }),
    connectionId: uuid().references(() => connections.id, { onDelete: "set null" }),
    // our action name, e.g. "gmail.send_email"
    action: text().notNull(),
    input: jsonb().notNull(),
    output: jsonb(),
    ok: boolean().notNull(),
    error: text(),
    ms: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);

// One per file in the company repo's automations/ folder: the file (git) is the source, this row is
// what runs. Rebuilt from git by syncAutomations; never edited on its own.
export const automations = pgTable(
  "automations",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    // the file name without .md
    name: text().notNull(),
    // the file's git blob sha, to skip unchanged files
    sha: text().notNull(),
    // whoever last saved the file: it runs as them, with their apps
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    when: text({ enum: ["trigger", "schedule", "manual"] }).notNull(),
    // our trigger name, e.g. gmail.new_gmail_message
    trigger: text(),
    triggerConfig: jsonb(),
    schedule: text(),
    timezone: text(),
    enabled: boolean().notNull(),
    prompt: text().notNull(),
    // the agent its runs hand the work to (company/agents/<slug>, agents.ts); null: Emplio does it
    agent: text(),
    // the app actions its runs take that send or change something (the file's actions:), and those of them an owner
    // or admin allowed: runs nobody watches do those without a card (approvals.ts). Allowed ones carry over a
    // re-save, but not to another person (it runs with their apps).
    actions: text().array().notNull().default([]),
    allowed: text().array().notNull().default([]),
    // which of the person's accounts of the trigger's app to watch (its label), when they have several
    account: text(),
    // what's wrong with the file (it doesn't run until fixed)
    error: text(),
    // the provider's id for the trigger it watches
    provider: text(),
    externalId: text(),
    // schedule: when it next runs; a trigger we poll (provider "poll"): when it's next checked
    nextRunAt: timestamp({ withTimezone: true }),
    // a trigger we poll: the item ids seen so far, for the settings in `key` (new settings start over)
    pollState: jsonb().$type<{ key: string; seen: string[] | null }>(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.name), index().on(t.externalId)],
);

// The skills in git (company/skills/<name>/SKILL.md, and each person's me/skills/<name>/SKILL.md), mirrored so
// the chat box can offer them as /commands and the prompt can list them without reading every file each message.
export const skills = pgTable(
  "skills",
  {
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    // "company", or "me-<userId>" for someone's own
    repo: text().notNull(),
    name: text().notNull(),
    description: text().notNull(),
    // SKILL.md's git blob sha, to skip unchanged files
    sha: text().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.repo, t.name] })],
);

// The text files in git (company/, restricted/, each me/), mirrored for searching without reading every file
// (file-index.ts): brought up to date from git, by blob sha, after every commit.
export const fileIndex = pgTable(
  "file_index",
  {
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    // "company", "restricted", or "me-<userId>"
    repo: text().notNull(),
    path: text().notNull(),
    sha: text().notNull(),
    text: text().notNull(),
    // 'simple' like messages.search: names and Hindi words match as typed; the path's words count too
    search: tsvector().generatedAlwaysAs((): SQL => sql`to_tsvector('simple', translate(path, '/._-', '    ') || ' ' || text)`),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.repo, t.path] }), index().using("gin", t.search)],
);

// What the AI employee made (anything it put in out/, files.ts made.ts): the Files page, previews in the chat,
// share links. Made again under the same name in the same chat, it's a new version of the same file.
export const madeFiles = pgTable(
  "made_files",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    // whose chat made it: they and the owner and admins see it
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    conversationId: uuid().references(() => conversations.id, { onDelete: "set null" }),
    name: text().notNull(),
    mediaType: text().notNull(),
    // our /files/... path of the newest version
    url: text().notNull(),
    size: integer().notNull(),
    version: integer().notNull().default(1),
    // "made": Emplio made it (from /work/out); "upload": someone attached it to a chat
    source: text().$type<"made" | "upload">().notNull().default("made"),
    // a document's words, for searching (and the preview of Word/PowerPoint files made before previewUrl)
    text: text().notNull().default(""),
    // Word and PowerPoint: a PDF copy, only for the preview in the app (downloads and shares stay the real file)
    previewUrl: text(),
    search: tsvector().generatedAlwaysAs((): SQL => sql`to_tsvector('simple', translate(name, '/._-', '    ') || ' ' || text)`),
    // set while it's shared: anyone with /s/<token> can open it
    shareToken: text().unique(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.workspaceId, t.updatedAt), index().on(t.conversationId, t.name), index().using("gin", t.search), uniqueIndex().on(t.url)],
);

// What a reader saw in a stretch of someone's chat, for the background agent (reader.ts). Outlives the chat.
export const chatNotes = pgTable(
  "chat_notes",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    conversationId: uuid().references(() => conversations.id, { onDelete: "set null" }),
    // whose chat it is
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    text: text().notNull(),
    // wakes the background agent now instead of at its next round
    urgent: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);

// Every time an automation ran, and the chat it ran in.
export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    automationId: uuid().references(() => automations.id, { onDelete: "set null" }),
    // kept after the automation is removed
    name: text().notNull(),
    reason: text({ enum: ["trigger", "schedule", "manual"] }).notNull(),
    conversationId: uuid().references(() => conversations.id, { onDelete: "set null" }),
    status: text({ enum: ["running", "done", "failed"] }).notNull().default("running"),
    error: text(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.workspaceId, t.startedAt), index().on(t.status, t.startedAt)],
);

// Every statement run on a business's own database (emplio db), by whom and from which chat: the audit trail.
export const dbQueries = pgTable(
  "db_queries",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    conversationId: uuid().references(() => conversations.id, { onDelete: "set null" }),
    kind: text({ enum: ["read", "write", "schema", "import", "export", "restore"] }).notNull(),
    sql: text().notNull(),
    ok: boolean().notNull(),
    error: text(),
    // rows returned or changed
    rows: integer(),
    ms: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt)],
);

// Threads Emplio hands work to (`emplio hand`, jobs.ts), the hidden record of each. One row per thread: its brief, what
// it's doing, its report, and its whole conversation, so `emplio hand <id>` can send it a message or a follow-up.
// An OK asked of the person before an action sends or changes something (approvals.ts): the card, their answer
// and how the action went. The reply that asked holds the card as it was; what happened to it is only here.
export const approvals = pgTable(
  "approvals",
  {
    // the card's id
    id: uuid().primaryKey(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    // the chat whose command asked
    conversationId: uuid().notNull().references(() => conversations.id, { onDelete: "cascade" }),
    // the chat the person is in: the one that started the job asking, or the same chat
    showIn: uuid().notNull().references(() => conversations.id, { onDelete: "cascade" }),
    card: jsonb().$type<Omit<Approval, "decision" | "result">>().notNull(),
    // null: waiting for them
    decision: text({ enum: ["once", "always", "deny", "timeout", "skipped"] }),
    result: jsonb().$type<NonNullable<Approval["result"]>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.showIn, t.createdAt), index().on(t.conversationId, t.createdAt)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid().notNull().references(() => conversations.id, { onDelete: "cascade" }),
    // the job that started it; null when Emplio did. depth: 1 for Emplio's, 2 for theirs, and so on
    parentId: uuid().references((): AnyPgColumn => jobs.id, { onDelete: "cascade" }),
    depth: integer().notNull().default(1),
    // its own chat, where it works: Emplio's brief is the first message, and the person can write to it there
    chatId: uuid().references((): AnyPgColumn => conversations.id, { onDelete: "set null" }),
    name: text().notNull(),
    // the agent it runs as (company/agents/<slug>, agents.ts); null: a plain copy of whoever started it
    agent: text(),
    // light: the business's job model; strong: its chat model. null: the agent's own level (light without one)
    level: text({ enum: ["light", "strong"] }),
    status: text({ enum: ["working", "done", "asking", "failed", "stopped"] }).notNull().default("working"),
    // notes standing in for the start of its conversation once it outgrew settings.compactAt (compact.ts)
    // ponytail: summary, actions and messages are only for jobs from before jobs were chats (chatId null);
    // drop them once those are gone
    summary: text(),
    // JobInfo["actions"], in order
    actions: jsonb().$type<JobInfo["actions"]>().notNull().default([]),
    // ModelMessage[]: the brief, every step and follow-up
    messages: jsonb().$type<unknown[]>().notNull().default([]),
    report: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
    // when the person opened it as its own chat: it stays under Chat in the sidebar until they close it (null)
    openedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.conversationId, t.createdAt), index().on(t.createdAt), index().on(t.status, t.createdAt)],
);

// Everything that happens in a business, one line each (activity.ts). conversationId has no foreign key on
// purpose: entries outlive the chat they came from.
export const activity = pgTable(
  "activity",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid().references(() => users.id, { onDelete: "set null" }),
    conversationId: uuid(),
    kind: text().notNull(),
    summary: text().notNull(),
    detail: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.workspaceId, t.createdAt), index().on(t.workspaceId, t.userId, t.createdAt), index().on(t.kind, t.createdAt)],
);

// A site's own requests that browser work has seen, per business (site-calls.ts): addresses and field names, never values.
export const siteCalls = pgTable(
  "site_calls",
  {
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    site: text().notNull(),
    host: text().notNull(),
    method: text().notNull(),
    path: text().notNull(),
    // a GraphQL operation's name: one address, many requests
    op: text().notNull().default(""),
    query: text().notNull().default(""),
    sends: text().notNull().default(""),
    returns: text().notNull().default(""),
    // the reply's field names, what a repeat is checked against
    keys: jsonb().$type<string[] | null>(),
    seenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.host, t.method, t.path, t.op] }), index().on(t.workspaceId, t.site, t.seenAt)],
);

// Sites a business's browsers go to on the paid connection (browser.ts): they turned the free one away, take a sign-in, or Emplio asked.
export const paidSites = pgTable(
  "paid_sites",
  {
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    site: text().notNull(),
    seenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.site] })],
);

// Tasks (tasks.ts): everything to be done in a business, by a person or by the AI (assigneeId null). Who
// asked is told when one is two days late; people are reminded on their channel once it's due.
export const tasks = pgTable(
  "tasks",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    title: text().notNull(),
    // how to do it: steps, a skill to follow, links
    notes: text(),
    // null: the AI's own
    assigneeId: uuid().references(() => users.id, { onDelete: "set null" }),
    requesterId: uuid().references(() => users.id, { onDelete: "set null" }),
    status: text({ enum: ["todo", "doing", "waiting", "done", "cancelled"] }).notNull().default("todo"),
    // who or what it's waiting on, while status is waiting
    waitingOn: text(),
    dueAt: timestamp({ withTimezone: true }),
    // the chat it came from
    conversationId: uuid().references(() => conversations.id, { onDelete: "set null" }),
    // the AI's own: the chat it last worked on it in
    workConversationId: uuid().references(() => conversations.id, { onDelete: "set null" }),
    // reminders sent to the assignee, and when the asker was told it's late; reset when the due date moves
    chasedAt: timestamp({ withTimezone: true }),
    chases: integer().notNull().default(0),
    escalatedAt: timestamp({ withTimezone: true }),
    doneAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.workspaceId, t.status, t.dueAt)],
);

// Saved passwords and keys (logins.ts): one person's, in one business. The value is encrypted (secrets.ts) and
// never reaches the AI: it uses the name, and the server types the password into the page or swaps the key
// into a request, only on `site` (and its subdomains).
export const logins = pgTable(
  "logins",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    // VERCEL, GITHUB_TOKEN: what the AI calls it
    name: text().notNull(),
    // "login": what a website's sign-in page asks for; "key": an API key or token
    kind: text().$type<"login" | "key">().notNull(),
    site: text().notNull(),
    // the first field that isn't secret (the email, phone or username), shown in lists
    username: text(),
    // a login's field labels ("Email", "Password"), in the order the page asks
    fields: text().array().notNull().default([]),
    // encrypted: a login's fields as JSON (label → text), or the key
    value: text().notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.userId, t.name)],
);

// MCP servers the business added (mcp.ts): remote tools every chat in it can use.
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    // what the AI calls it: notion, linear
    name: text().notNull(),
    url: text().notNull(),
    // encrypted JSON: header name → value; a value can hold {{NAME}}, the caller's own saved key
    headers: text(),
    enabled: boolean().notNull().default(true),
    createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.workspaceId, t.name)],
);

// One person's sign-in to an MCP server that uses OAuth (mcp.ts): encrypted JSON of the registered client,
// the tokens, and the code verifier while a sign-in is under way.
export const mcpAuth = pgTable(
  "mcp_auth",
  {
    serverId: uuid().notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
    userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
    data: text().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.userId] })],
);

// --- Usage and credit. Money is kept in micro-dollars (1 = $0.000001) so tiny AI calls add up exactly. ---


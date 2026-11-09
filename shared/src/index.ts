export type HealthResponse = { ok: boolean; version: string };
// GET /changelog: one version's "What's new" (backend changelog.ts), newest first
export type Release = { version: string; date: string; changes: string[] };

export type User = { id: string; email: string; name: string | null };
export type Workspace = { id: string; name: string; role: "owner" | "admin" | "member" };

export type AuthStartRequest = { email: string };
// notEmailed: no email service on this server, so the code is only in its log
export type AuthStartResponse = { isNewUser: boolean; notEmailed?: boolean };

export type AuthVerifyRequest = { email: string; code: string };

export type SetNameRequest = { name: string };

export type MeResponse = { user: User; workspaces: Workspace[] };

// running: a reply is being written right now; unread: one finished while the chat wasn't open
// channel: where the person talks in it (the web app, or Telegram)
// kind main: the person's main chat (the same one on their phone), listed first
export type ConversationSummary = { id: string; title: string; updatedAt: string; running: boolean; unread: boolean; channel: "web" | "telegram"; kind: "chat" | "main"; archived: boolean };
// A job's own chat, as GET /conversations/:id adds it: the job it is
export type ChatJob = { id: string; name: string; agent: string | null; status: JobInfo["status"] };
export type UpdateConversationRequest = { title?: string; archived?: boolean };

export type Role = Workspace["role"];
// reportsTo: the user id of who they report to, if anyone
export type TeamMember = { id: string; name: string | null; email: string; role: Role; reportsTo: string | null };
export type AddMemberRequest = { email: string; name?: string; role?: "admin" | "member" };
export type UpdateMemberRequest = { role?: "admin" | "member"; reportsTo?: string | null };

// label: which account (the Gmail address, or a name the person gave it); tells several of one app apart
export type Connection = { id: string; app: string; name: string; label: string; logo?: string; keyField?: KeyField; signIn?: boolean; status: "pending" | "active" | "expired" | "failed"; createdAt: string };
// keyField: the app is connected by pasting a key (shown as a form), not by signing in on its page
export type KeyField = { label: string; help: string; placeholder?: string };
// signIn: besides the key, can be signed in to on the app's own page
export type AppInfo = { app: string; name: string; description: string; logo?: string; category?: AppCategory; keyField?: KeyField; signIn?: boolean };
// shown in the chat when the agent asks someone to connect an app; path is our own /connect link on the API
// Categories offered when browsing apps; providers map these keys to their own.
export const APP_CATEGORIES = [
  { key: "email", label: "Email" },
  { key: "calendar", label: "Calendar" },
  { key: "docs", label: "Docs" },
  { key: "spreadsheets", label: "Spreadsheets" },
  { key: "accounting", label: "Accounting" },
  { key: "crm", label: "CRM" },
  { key: "chat", label: "Team chat" },
  { key: "messaging", label: "Messaging" },
  { key: "payments", label: "Payments" },
  { key: "productivity", label: "Productivity" },
  { key: "developer", label: "Developer" },
  { key: "ai", label: "AI models" },
] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number]["key"];
// connection: set when it reconnects one account (of several) rather than adding one
// existing: the person's accounts of the app when it was made, so a card adding another isn't "done" by them
// mcp: an MCP server's sign-in (path is its page), not an app's
export type ConnectCard = { app: string; name: string; logo?: string; path: string; keyField?: KeyField; signIn?: boolean; connection?: string; existing?: string[]; mcp?: boolean };
// A saved password or key (never its value): the AI uses it by name, the server fills it in (backend logins.ts).
// day-one setup (backend setup.ts): briefed and written down, skipped by the owner, or not yet; at: when done or skipped
export type SetupStatus = { state: "done" | "skipped" | "not-started"; at: string | null };
// Bringing a person's memory over from another AI (backend imports.ts)
export const IMPORT_SOURCES = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", grok: "Grok", openclaw: "OpenClaw", hermes: "Hermes", other: "another AI" } as const;
export type ImportSource = keyof typeof IMPORT_SOURCES;
// notes: files saved to their own folder; chats: old chats saved (archived, searchable), new ones only; sorting: the AI's task sorting it
export type ImportResult = { notes: number; chats: number; messages: number; made: number; sorting: boolean };
export type LoginKind = "login" | "key";
// fields: the labels a login was saved with ("Email", "Password"); username: the first one that isn't secret
export type Login = { id: string; name: string; kind: LoginKind; site: string; username: string | null; fields: string[]; usedAt: string | null; createdAt: string };
// a login: fields, label → what to type (whatever that site's sign-in page asks for); a key: value
export type LoginInput = { name: string; kind: LoginKind; site: string; fields?: Record<string, string>; value?: string };
// "Save a login" button the chat shows under a reply (emplio logins ask)
// fields: what the site's sign-in page asks for, as labelled there; none given → email/username and password
export type SaveLoginCard = { name: string; kind: LoginKind; site: string; fields?: string[] };
// A question with answers to tap (emplio ask); the tapped answer is sent as the person's next message
// multi: any number of answers may be picked (sent as one line, "Gmail, Slack")
// text: what they need to read to answer (a draft, a list), shown above the question
export type AskCard = { id: string; question: string; options: string[]; multi?: boolean; text?: string };
export const DEFAULT_LOGIN_FIELDS = ["Email or username", "Password"];
// a field typed in hidden (password, PIN, security answer), and never shown back
export const isSecretField = (label: string) => /pass|pin\b|secret|security|answer|passcode|mpin/i.test(label);
export type ActionInfo = { action: string; description: string };
// title: the provider's own name for it ("Send Email"); readOnly: only looks things up, so it runs without asking
export type ActionDetail = ActionInfo & {
  app: string;
  input: { name: string; type: string; required: boolean; description: string }[];
  title?: string;
  readOnly?: boolean;
};
// GET /mentions?q=: something the chat box's @ menu offers. id: a teammate's user id, a file's path under /work
// (company/..., me/..., restricted/...), a chat id, a connection id or a table name. Picked ones go in the
// message as a part { type: "data-mentions", data: Mention[] }.
export type MentionKind = "person" | "record" | "task" | "file" | "chat" | "app" | "table";
export type Mention = { kind: MentionKind; id: string; label: string; detail?: string; logo?: string };

// GET /commands?q=: what the chat box's / menu offers. A skill or app is put in the message as /name; an
// automation runs right away. Searched on the server, so a thousand apps don't all come to the page.
export type SlashCommand =
  | { kind: "skill"; name: string; description: string; scope: "company" | "me" }
  | { kind: "automation"; name: string; description: string }
  | { kind: "app"; name: string; description: string; logo?: string; connected: boolean };

// GET /skills: a skill the chat box offers as /name; scope "me" is the person's own
export type Skill = { name: string; description: string; scope: "company" | "me" };

// An app action waiting for the person's OK (anything that sends, changes or deletes), shown in the chat
// with Allow / Always allow / Deny. decision: set once answered, or "timeout" when nobody did.
export type Approval = {
  id: string;
  action: string;
  app: string;
  appName: string;
  logo?: string;
  title: string;
  input: unknown;
  // after this nobody can answer it (approvals.ts)
  expiresAt?: string;
  // asked every time: no "Always allow" (installing a skill from the public store)
  oneOff?: boolean;
  // skipped: they wrote a message instead of answering
  decision?: "once" | "always" | "deny" | "timeout" | "skipped";
};
export type ActionRun = { id: string; action: string; ok: boolean; error: string | null; conversationId: string | null; createdAt: string };

// An automation: company/automations/<name>.md, as the server reads it. error: why it can't run.
export type AutomationRun = {
  id: string;
  name: string;
  reason: "trigger" | "schedule" | "manual";
  status: "running" | "done" | "failed";
  error: string | null;
  conversationId: string | null;
  startedAt: string;
  finishedAt: string | null;
};
export type Automation = {
  name: string;
  when: "trigger" | "schedule" | "manual";
  trigger: string | null;
  schedule: string | null;
  timezone: string | null;
  enabled: boolean;
  prompt: string;
  // the agent its runs hand the work to
  agent: string | null;
  // the app actions its runs take that send or change something (gmail.send_email), and those of them allowed: runs do
  // those without asking; anything else they're refused
  actions: { action: string; title: string; app: string; logo?: string; allowed: boolean }[];
  error: string | null;
  // who it runs as: whoever last saved it
  owner: { id: string; name: string } | null;
  nextRunAt: string | null;
  lastRun: AutomationRun | null;
};

// A message found by searching one's chats; snippet marks the matches with **.
export type SearchHit = {
  conversationId: string;
  title: string;
  messageId: string;
  role: "system" | "user" | "assistant";
  createdAt: string;
  snippet: string;
  // its place in the chat (1 = first message)
  n: number;
};

// The few things about how the AI employee behaves that a business may want to tune: the Settings screen
// draws itself from this list and the server checks against it. A workspace stores only what it changed;
// everything else is the default (the server's env can move a default, see backend/src/settings.ts).
export const SETTING_SECTIONS = [
  { key: "work", label: "Agent", help: "Which models it uses and how it works." },
  { key: "memory", label: "Context", help: "Keeping long chats cheap." },
  { key: "computer", label: "Sandbox", help: "Limits on its computer." },
  { key: "schedule", label: "Schedule", help: "What it does on its own in the background, and when." },
] as const;

// A check-in's message to the agent starts with this; the chat shows it as a small "Check-in" line.
export const CHECK_IN_PREFIX = "[Check-in] ";
// The day's first check-in and the evening one (heartbeat.ts); shown as "Morning brief" and "End-of-day report".
export const BRIEF_PREFIX = "[Morning brief] ";
export const REPORT_PREFIX = "[End-of-day report] ";
// Jobs' reports handed to the chat after its reply ended (they took longer); shown as "Jobs finished".
export const JOBS_DONE_PREFIX = "[Jobs done] ";
// What the person did in the live browser with "Show Emplio how", handed to Emplio; shown as "You showed Emplio how".
export const SHOWN_PREFIX = "[Shown] ";
// A thread telling Emplio something the person said in its chat (`emplio threads notify`); shown as "Message from Emplio's work".
// The prefixes keep their old words: they're in saved chats, and matched there.
export const JOB_NOTE_PREFIX = "[From a job] ";
// In a job's own chat: a message from Emplio (its brief, or a follow-up); the rest are the person's, written to it
// directly. Shown with an "Emplio" label.
export const FROM_EMPLIO = "[From Emplio] ";
// the same, in chats from before jobs were called workers
export const WORKERS_DONE_PREFIX = "[Workers done] ";
// A reply a server restart cut off, carried on once it's back (resume.ts); shown as "Picked up after a restart".
export const RESUMED_PREFIX = "[Resumed] ";
// A note the old background skill review left in chats of what it saved; still shown as a "Learned" line.
export const LEARNED_PREFIX = "[Learned] ";
// An automation's or task's instructions to the agent; shown as "Automation started" / "Task started".
export const AUTOMATION_PREFIX = "[Automation] ";
export const TASK_PREFIX = "[Task] ";

export type SettingField = {
  key: string;
  section: (typeof SETTING_SECTIONS)[number]["key"];
  label: string;
  help: string;
  // shown under Advanced, for whoever on the team wants to pick models themselves
  advanced?: boolean;
} & (
  | { type: "number"; default: number; min: number; max: number; unit: string }
  // hint: one line on what picking it means, shown under the choice while it's picked
  | { type: "choice"; default: string; options: { value: string; label: string; hint?: string }[] }
  | { type: "toggle"; default: boolean }
  // any model from GET /models (picked by maker, then searched by name), or "auto": the one MODEL_SETS has for it
  | { type: "model"; default: string }
  // a secret: stored encrypted, sent back only as KEY_MASK + its last 4 characters
  | { type: "key"; default: string; placeholder: string }
);
export const KEY_MASK = "••••••••";

export const SETTING_FIELDS = [
  {
    key: "modelSet",
    section: "work",
    label: "Quality",
    help: "Better models handle harder jobs but cost more.",
    type: "choice",
    default: "default",
    options: [
      { value: "free", label: "Free", hint: "Free models. Often busy or wrong, and their makers may keep your data." },
      { value: "save", label: "Save money", hint: "Claude Haiku. Cheapest paid option, fine for simple jobs." },
      { value: "default", label: "Default", hint: "Claude Sonnet for chats, Haiku for background and handed-off work. Reliable for most work." },
      { value: "best", label: "Best quality", hint: "Claude Opus for chats, Sonnet for background and handed-off work. About twice the cost of Default." },
    ],
  },
  {
    key: "chatModel",
    section: "work",
    advanced: true,
    label: "Chat model",
    help: "Runs chats people type in.",
    type: "model",
    default: "auto",
  },
  {
    key: "backgroundModel",
    section: "work",
    advanced: true,
    label: "Background model",
    help: "Runs check-ins, automations and tasks, with nobody waiting on the reply.",
    type: "model",
    default: "auto",
  },
  {
    key: "jobModel",
    section: "work",
    advanced: true,
    label: "Job model",
    help: "Runs the work Emplio hands off in a chat.",
    type: "model",
    default: "auto",
  },
  {
    key: "openrouterKey",
    section: "work",
    advanced: true,
    label: "Your OpenRouter key",
    help: "Bill AI use to your own OpenRouter account. Empty uses ours.",
    type: "key",
    default: "",
    placeholder: "sk-or-…",
  },
  {
    key: "reasoning",
    section: "work",
    advanced: true,
    label: "Reasoning effort",
    help: "How much it thinks before acting.",
    type: "choice",
    default: "medium",
    options: [
      { value: "off", label: "Off", hint: "Answers at once. Fastest, but more mistakes." },
      { value: "low", label: "Low", hint: "A quick think. Fine for simple questions." },
      { value: "medium", label: "Medium", hint: "A good balance." },
      { value: "high", label: "High", hint: "Most careful. Slowest and priciest." },
    ],
  },
  {
    key: "maxSteps",
    section: "work",
    label: "Max steps per reply",
    help: "Stops a reply after this many actions, so a stuck one can't run up costs.",
    type: "number",
    default: 60,
    min: 1,
    max: 200,
    unit: "steps",
  },
  {
    key: "approvals",
    section: "work",
    label: "Before sending or changing things",
    help: "Emails, messages, edits and deletes in your apps. Lookups never ask.",
    type: "choice",
    default: "ask",
    options: [
      { value: "ask", label: "Ask first", hint: "You approve each one in the chat." },
      { value: "auto", label: "Just do it", hint: "No approval. Faster, but nobody checks." },
    ],
  },
  {
    key: "visualReplies",
    section: "work",
    label: "Rich replies",
    help: "Tables, charts and buttons in replies. Makes each reply a bit pricier.",
    type: "toggle",
    default: false,
  },
  {
    key: "compactAt",
    section: "memory",
    label: "Compact at",
    help: "Past this size, older messages are summarised to keep replies cheap. Nothing is deleted.",
    type: "number",
    default: 100_000,
    min: 5_000,
    max: 1_000_000,
    unit: "tokens",
  },
  {
    key: "summaryModel",
    section: "work",
    advanced: true,
    label: "Compaction model",
    help: "Writes those summaries and reads quiet chats for the background agent. A cheap, fast one is fine.",
    type: "model",
    default: "auto",
  },
  {
    key: "checkIns",
    section: "schedule",
    label: "Background rounds",
    help: "How often it looks around on its own during the working day, works through what it noticed in chats, and tells you only what needs you.",
    type: "choice",
    default: "2h",
    options: [
      { value: "off", label: "Off", hint: "Only works when messaged. No rounds, briefs or reports." },
      { value: "1h", label: "Every hour", hint: "Fastest to notice, costs most." },
      { value: "2h", label: "Every 2 hours", hint: "About 6 a day." },
      { value: "4h", label: "Every 4 hours", hint: "About 3 a day." },
      { value: "daily", label: "Once a day", hint: "Morning brief and evening report only, plus anything urgent." },
    ],
  },
  {
    key: "briefHour",
    section: "schedule",
    label: "Morning brief",
    help: "Your brief of the day, and the start of its working day: no rounds before this.",
    type: "choice",
    default: "9",
    options: [
      { value: "7", label: "7am" },
      { value: "8", label: "8am" },
      { value: "9", label: "9am" },
      { value: "10", label: "10am" },
      { value: "11", label: "11am" },
    ],
  },
  {
    key: "staffBriefs",
    section: "schedule",
    label: "Staff briefs and reports",
    help: "Each team member gets their own morning brief (their meetings, tasks and emails) and end-of-day report (their day, and tomorrow), at the same times as yours. Silent when there's nothing for them.",
    type: "toggle",
    default: true,
  },
  {
    key: "reportHour",
    section: "schedule",
    label: "End-of-day report",
    help: "What got done, what didn't and what's next. Its working day ends an hour after this.",
    type: "choice",
    default: "19",
    options: [
      { value: "off", label: "Off", hint: "No report; rounds stop at 8pm." },
      { value: "17", label: "5pm" },
      { value: "18", label: "6pm" },
      { value: "19", label: "7pm" },
      { value: "20", label: "8pm" },
      { value: "21", label: "9pm" },
    ],
  },
  {
    key: "readAfter",
    section: "schedule",
    label: "Read chats after",
    help: "How long a chat must be quiet before it's read for the background rounds. Shorter notices things sooner; each read costs a fraction of a rupee.",
    type: "number",
    default: 10,
    min: 5,
    max: 120,
    unit: "minutes",
  },
  {
    key: "commandSeconds",
    section: "computer",
    label: "Command timeout",
    help: "Stops a command that runs longer than this.",
    type: "number",
    default: 120,
    min: 10,
    max: 600,
    unit: "seconds",
  },
] as const satisfies readonly SettingField[];

type Field = (typeof SETTING_FIELDS)[number];
export type Settings = {
  [F in Field as F["key"]]: F["type"] extends "number" ? number : F["type"] extends "toggle" ? boolean : string;
};
// What each Quality choice (modelSet) runs, per job. A model setting left on "auto" uses its job's one here.
// ponytail: Anthropic for the agent's own work because chat.ts's prompt caching is written for it; test others before adding them
export const MODEL_SETS = {
  // OpenRouter's own pick among its free models (with tools), a different one per request
  free: { chatModel: "openrouter/free", backgroundModel: "openrouter/free", jobModel: "openrouter/free", summaryModel: "openrouter/free" },
  save: { chatModel: "anthropic/claude-haiku-5.5", backgroundModel: "anthropic/claude-haiku-5.5", jobModel: "anthropic/claude-haiku-5.5", summaryModel: "anthropic/claude-haiku-5.5" },
  default: { chatModel: "anthropic/claude-sonnet-5.5", backgroundModel: "anthropic/claude-haiku-5.5", jobModel: "anthropic/claude-haiku-5.5", summaryModel: "anthropic/claude-haiku-5.5" },
  best: { chatModel: "anthropic/claude-opus-5.5", backgroundModel: "anthropic/claude-sonnet-5.5", jobModel: "anthropic/claude-haiku-5.5", summaryModel: "anthropic/claude-haiku-5.5" },
} as const;
export type ModelJob = keyof (typeof MODEL_SETS)["default"];

// The model a job runs on: its own setting, or with that on "auto", the one its Quality choice has.
export const modelFor = <J extends ModelJob>(settings: Pick<Settings, "modelSet" | J>, job: J): string =>
  settings[job] !== "auto" ? settings[job] : (MODEL_SETS[settings.modelSet as keyof typeof MODEL_SETS] ?? MODEL_SETS.default)[job];

// The makers whose models can be the brain, in the order the picker shows them.
export const MODEL_PROVIDERS = [
  { key: "anthropic", label: "Anthropic (Claude)" },
  { key: "openai", label: "OpenAI (GPT)" },
  { key: "google", label: "Google (Gemini)" },
  { key: "x-ai", label: "xAI (Grok)" },
  { key: "qwen", label: "Alibaba (Qwen)" },
  { key: "z-ai", label: "Zhipu (GLM)" },
  { key: "mistralai", label: "Mistral" },
  { key: "meta-llama", label: "Meta (Llama)" },
] as const;

// GET /models: models that read text, images and files, write text and can use tools. Prices per million tokens.
export type ModelOption = {
  id: string;
  name: string;
  provider: (typeof MODEL_PROVIDERS)[number]["key"];
  context: number;
  input: number;
  output: number;
};

// `emplio report`: Emplio telling its makers about a fault. The person never sees it, so the chat leaves its line out.
export const isReport = (command?: string) => /^\s*emplio report\b/.test(command ?? "");

// One step of the checklist the agent keeps for a long job (emplio plan), as a command's output carries it.
export type PlanStep = { text: string; status: "todo" | "doing" | "done" };

// GET /agents: Emplio's agents, read-only for the Team window (made and changed by Emplio in chat)
export type AgentInfo = { slug: string; name: string; description: string; skills: string[]; lessons: string[] };

// GET /jobs/:id: a piece of work Emplio handed off (emplio hand), shown live in the chat.
// GET /jobs: the person's latest jobs (Emplio's own, not theirs), nested under Chat in the sidebar
// startedIn: the chat it nests under in the sidebar, through any jobs that started it
export type JobSummary = Pick<JobInfo, "id" | "name" | "agent" | "status" | "chatId"> & { startedIn: string };

// A hand-off's card, in a command's output: the job and the run its prompt started (`job/run`, the prompt's message
// id in the job's chat). Each prompt is its own run, so an earlier card stays finished. Older ones: the job alone.
export const runRef = (job: string, run: string) => `${job}/${run}`;
export const splitRef = (ref: string) => {
  const [id, run] = ref.split("/");
  return { id: id!, run };
};

export type JobInfo = {
  id: string;
  name: string;
  // the agent it runs as, by name ("Supplier Finder"); null: Emplio's own copy
  agent: string | null;
  // asking: it ended with a question and waits for the answer
  status: "working" | "done" | "asking" | "failed" | "stopped";
  // saved/connect: files it offered the person and apps it asked them to connect, as a command's output has them
  actions: {
    id: string;
    description: string;
    exitCode?: number;
    error?: boolean;
    done: boolean;
    saved?: { url: string; filename: string }[];
    connect?: ConnectCard[];
    logins?: SaveLoginCard[];
    approvals?: Approval[];
    // jobs it started (workers: the same, saved before jobs were called workers)
    jobs?: string[];
    workers?: string[];
  }[];
  report: string | null;
  // its own chat (a conversation of kind "job"), where it works and the person can talk to it; null: a job
  // from before jobs were chats
  chatId: string | null;
};

// GET /knowledge: the notes (.md files) this person can see, by folder (a git repo)
export type KnowledgeFolder = { repo: string; label: string; files: string[] };

export type DbTable = { name: string; type: string; rows: number | null; private: boolean };
export type DbRows = { columns: string[]; rows: (string | number | null)[][]; total: number; offset: number; limit: number };

// GET /settings; PUT /settings takes Partial<Record<key, value | null>>, null putting it back to the default
export type SettingsResponse = { values: Settings; defaults: Settings; canEdit: boolean };

// Tasks for people and for the AI (assigneeId null).
export const TASK_STATUSES = ["todo", "doing", "waiting", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type Task = {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatus;
  waitingOn: string | null;
  assigneeId: string | null;
  assigneeName: string;
  requesterId: string | null;
  requesterName: string | null;
  dueAt: string | null;
  conversationId: string | null;
  // the AI's own: the chat it last worked on it in
  workConversationId: string | null;
  // the AI is working on it right now (its work chat is replying)
  running: boolean;
  chases: number;
  createdAt: string;
  doneAt: string | null;
};
export type TaskInput = { title?: string; notes?: string | null; status?: TaskStatus; waitingOn?: string | null; assigneeId?: string | null; dueAt?: string | null };

// A file the AI employee made (backend made.ts): the Files page and the previews in the chat.
export type MadeFile = {
  id: string;
  name: string;
  mediaType: string;
  // our /files/... path of the newest version
  url: string;
  size: number;
  version: number;
  conversationId: string | null;
  conversationTitle: string | null;
  userName: string | null;
  // Word and PowerPoint: a PDF copy of it, to show in the app
  previewUrl: string | null;
  // "made": Emplio made it; "upload": someone attached it to a chat
  source: "made" | "upload";
  // the public link while it's shared
  shareUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

// An MCP server the business added (Settings → Developers → MCP, or emplio mcp). Header values come back masked
// (KEY_MASK + last 4), except {{NAME}} references to a person's saved key, which are shown as is.
// signedIn: the person looking has signed in to it (servers with their own sign-in)
// An MCP server's icon: its site's favicon, looked up by the API (GET /favicon, mcp.ts), so a path on it.
// "" for an address that isn't one yet.
export function mcpLogo(url: string) {
  try {
    const host = new URL(url.trim()).hostname;
    return host.includes(".") ? `/favicon?host=${host}` : "";
  } catch {
    return "";
  }
}

export type McpServer = { id: string; name: string; url: string; headers: { name: string; value: string }[]; enabled: boolean; signedIn?: boolean };
// a masked value sent back unchanged keeps the saved one
export type McpServerInput = { name: string; url: string; headers: { name: string; value: string }[]; enabled: boolean };
export type McpTool = { name: string; description: string; readOnly: boolean };


// How well a name fits what's typed in the @ and / menus; lower is better. q is lowercase and trimmed.
// 0 the name starts with it, 1 a word does, 2 it's anywhere, 3 it's in the description; FUZZY and up, on the name only:
// its letters in order, then a small typo. The server and the app's instant results rank alike.
export const FUZZY = 4;
export const NO_MATCH = 9;

const WORD_BREAK = /[\s._/-]+/;

// letters in order, starting at a word, and close together: "rnmd" is Runmind; a letter from each end of a long name isn't
function inOrder(name: string, q: string) {
  for (let start = name.indexOf(q[0]!); start !== -1; start = name.indexOf(q[0]!, start + 1)) {
    if (start > 0 && !WORD_BREAK.test(name[start - 1]!)) continue;
    let at = start;
    for (let i = 1; i < q.length && at !== -1; i++) at = name.indexOf(q[i]!, at + 1);
    if (at !== -1 && at - start < q.length * 3) return true;
  }
  return false;
}

// edits between two words, a swap of neighbours counting as one
function edits(a: string, b: string) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const same = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + same);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  return rows[a.length]![b.length]!;
}

export function matchScore(name: string, more: string, q: string) {
  if (!q) return 0;
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 0;
  const words = n.split(WORD_BREAK).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 1;
  if (n.includes(q)) return 2;
  if (more.toLowerCase().includes(q)) return 3;
  if (q.length < 3) return NO_MATCH;
  if (inOrder(n, q)) return FUZZY;
  if (q.length < 4) return NO_MATCH;
  // the whole word, or the part of it typed so far
  const allowed = q.length < 8 ? 1 : 2;
  return words.some((w) => edits(w, q) <= allowed || edits(w.slice(0, q.length), q) <= allowed) ? FUZZY + 1 : NO_MATCH;
}

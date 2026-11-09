// Builds src/integrations/own/slack/actions.json from Slack's docs: one action per Web API method a bot or user token can
// call. Slack's OpenAPI spec is years stale; every docs page has a markdown twin with the method's scopes and arguments.
// Run again when Slack's API grows, from backend/:  bun scripts/openapi/slack.ts
// (not an openapi-actions.ts config: there's no spec to feed it, and each action also says which token it needs)
import { composioNames } from "./composio-names";

const DOCS = "https://docs.slack.dev";

// Composio's name(s) for the same call, so skills and saved automations carry over. The rest are named after the method.
const NAMES: Record<string, string[]> = {
  "api.test": ["api_test"],
  "auth.test": ["test_auth", "who_am_i", "get_app_permission_scopes"],
  "auth.teams.list": ["list_auth_teams"],
  "bots.info": ["get_bot_user"],
  "calls.add": ["start_call"],
  "calls.end": ["end_call"],
  "calls.info": ["get_call_info"],
  "calls.update": ["update_call_info"],
  "calls.participants.add": ["add_call_participants"],
  "calls.participants.remove": ["remove_call_participants"],
  "canvases.create": ["create_canvas"],
  "canvases.delete": ["delete_canvas"],
  "canvases.edit": ["edit_canvas"],
  "canvases.sections.lookup": ["lookup_canvas_sections"],
  "chat.delete": ["deletes_a_message_from_a_chat"],
  "chat.deleteScheduledMessage": ["delete_scheduled_message"],
  "chat.getPermalink": ["retrieve_message_permalink_url"],
  "chat.meMessage": ["send_me_message"],
  "chat.postEphemeral": ["send_ephemeral_message"],
  "chat.postMessage": ["send_message", "chat_post_message"],
  "chat.scheduleMessage": ["schedule_message"],
  "chat.scheduledMessages.list": ["list_scheduled_messages"],
  "chat.unfurl": ["customize_url_unfurl"],
  "chat.update": ["updates_a_slack_message"],
  "conversations.archive": ["archive_conversation"],
  "conversations.close": ["close_dm"],
  "conversations.create": ["create_channel", "create_channel_based_conversation"],
  "conversations.history": ["fetch_conversation_history"],
  "conversations.info": ["retrieve_conversation_information"],
  "conversations.invite": ["invite_users_to_a_slack_channel", "invite_user_to_channel"],
  "conversations.join": ["join_an_existing_conversation"],
  "conversations.kick": ["remove_user_from_conversation"],
  "conversations.leave": ["leave_conversation", "leave_a_conversation"],
  "conversations.list": ["list_all_channels"],
  "conversations.mark": ["set_read_cursor_in_a_conversation"],
  "conversations.members": ["retrieve_conversation_members_list"],
  "conversations.open": ["open_dm"],
  "conversations.rename": ["rename_conversation"],
  "conversations.replies": ["fetch_message_thread_from_a_conversation"],
  "conversations.setPurpose": ["set_conversation_purpose"],
  "conversations.setTopic": ["set_the_topic_of_a_conversation"],
  "conversations.unarchive": ["unarchive_channel"],
  "dnd.endDnd": ["end_dnd"],
  "dnd.endSnooze": ["end_snooze"],
  "dnd.info": ["retrieve_current_user_dnd_status"],
  "dnd.setSnooze": ["set_dnd_duration"],
  "dnd.teamInfo": ["get_user_dnd_status"],
  "emoji.list": ["list_custom_emojis"],
  "files.comments.delete": ["delete_file_comment"],
  "files.completeUploadExternal": ["complete_external_file_upload"],
  "files.delete": ["delete_file"],
  "files.getUploadURLExternal": ["reserve_file_upload"],
  "files.info": ["retrieve_detailed_information_about_a_file"],
  "files.list": ["list_files_with_filters_in_slack"],
  "files.remote.add": ["add_remote_file"],
  "files.remote.info": ["get_remote_file"],
  "files.remote.list": ["list_remote_files"],
  "files.remote.remove": ["remove_remote_file"],
  "files.remote.share": ["share_remote_file"],
  "files.remote.update": ["update_remote_file"],
  "files.revokePublicURL": ["revoke_file_public_sharing"],
  "files.sharedPublicURL": ["enable_public_sharing_of_a_file"],
  "pins.add": ["pin_item"],
  "pins.list": ["list_pinned_items"],
  "pins.remove": ["unpin_item"],
  "reactions.add": ["add_reaction_to_an_item"],
  "reactions.get": ["fetch_item_reactions"],
  "reactions.list": ["list_user_reactions"],
  "reactions.remove": ["remove_reaction_from_item"],
  "reminders.add": ["create_a_reminder"],
  "reminders.delete": ["delete_reminder"],
  "reminders.info": ["get_reminder"],
  "reminders.list": ["list_reminders"],
  "search.all": ["search_all"],
  "search.files": ["search_files"],
  "search.messages": ["search_messages"],
  "slackLists.access.delete": ["delete_slack_list_access"],
  "slackLists.access.set": ["set_slack_list_access"],
  "slackLists.create": ["create_slack_list"],
  "slackLists.items.create": ["create_slack_list_item"],
  "slackLists.items.delete": ["delete_slack_list_item"],
  "slackLists.items.deleteMultiple": ["delete_multiple_slack_list_items"],
  "slackLists.items.info": ["get_slack_list_item"],
  "slackLists.items.list": ["list_slack_list_items"],
  "slackLists.items.update": ["update_slack_list_item"],
  "slackLists.update": ["update_slack_list"],
  "stars.add": ["add_star"],
  "stars.list": ["list_starred_items"],
  "stars.remove": ["remove_star"],
  "team.info": ["fetch_team_info"],
  "team.profile.get": ["get_team_profile"],
  "usergroups.create": ["create_user_group"],
  "usergroups.disable": ["disable_user_group"],
  "usergroups.enable": ["enable_user_group"],
  "usergroups.list": ["list_user_groups"],
  "usergroups.update": ["update_user_group"],
  "usergroups.users.list": ["list_user_group_members"],
  "usergroups.users.update": ["update_user_group_members"],
  "users.conversations": ["list_conversations"],
  "users.deletePhoto": ["delete_user_profile_photo"],
  "users.getPresence": ["get_user_presence"],
  "users.info": ["retrieve_detailed_user_information"],
  "users.list": ["list_all_users"],
  "users.lookupByEmail": ["find_user_by_email_address"],
  "users.profile.get": ["retrieve_user_profile_information"],
  "users.profile.set": ["set_user_profile", "set_status"],
  "users.setPhoto": ["set_profile_photo"],
  "users.setPresence": ["set_user_presence", "manually_set_user_presence"],
};

// left out, with why: for COVERAGE.md
const SKIP: [RegExp, string][] = [
  [/^admin\./, "Enterprise org admin token only; a workspace's bot or user login can't call it"],
  [/^rtm\./, "classic apps only, and it opens a live socket rather than answering"],
  [/^(oauth|openid)\./, "part of signing in, done by the server with the client secret"],
  [/^apps\.(manifest|connections|event|uninstall|auth|icon|managed|activities)/, "takes an app-level or configuration token, needs Slack's hosted platform, or is for managed partner apps"],
  [/^tooling\./, "takes a configuration token"],
  [/^apps\.datastore\./, "Slack's hosted-app storage, which an app run on our server doesn't have"],
  [/^functions\.|^workflows\.triggers\./, "only callable from inside a Slack-hosted workflow step"],
  [/^assistant\.threads\.|^agents\./, "needs Slack's Agents and AI Apps feature on the app, which Emplio's Slack app doesn't use"],
  [/^assistant\.search\./, "the Real-time Search scopes are for apps with Slack's AI features on; search_messages, search_files and search_all do the same on the person's own login"],
  [/^entity\./, "Work Objects, which need their own app configuration in Slack"],
  [/^slackbot\.skills\./, "manages Slackbot's AI skills, and its scopes could block a normal sign-in on workspaces without them"],
  [/^auth\.revoke$/, "would log Emplio out of the connection; disconnecting is done in Emplio"],
  [/^migration\./, "an Enterprise migration helper that needs the legacy tokens.basic scope"],
  [/^team\.(accessLogs|billableInfo|integrationLogs)$/, "needs the admin scope, which could stop ordinary members from connecting at all"],
  [/^users\.identity$/, "for Sign in with Slack; its identity:read scope isn't in Slack's scope list, and retrieve_user_profile_information covers it"],
  [/^files\.upload$/, "Slack retired it in November 2025; upload_or_create_a_file_in_slack does the same"],
];

// these only look things up. A method's name is the only sign: Slack's listed HTTP verb says GET for some that change things.
const READS = /\.(list|info|history|replies|members|test|all|messages|files|conversations|validate|teamInfo|getPermalink|getPresence|getContent|lookup|lookupByEmail|listConnectInvites|get)$/;
const NOT_READS = new Set(["files.getUploadURLExternal", "conversations.leave"]);
const LIMITED = " Slack limits apps not listed on its Marketplace to about 1 call a minute and 15 messages a call here, so don't loop over it.";
// the docs give these no description at all
const BLANK: Record<string, string> = {
  count: "How many results to return per page.",
  page: "Which page of results to return, counting from 1.",
  include_archived: "Also include archived items.",
  interactivity_pointer: "Pointer from a button or shortcut, in place of trigger_id.",
};
const FILE = ' A file from the computer: {"file": "/work/..."}.';
const FILES: Record<string, string[]> = { "users.setPhoto": ["image"], "files.remote.add": ["preview_image", "indexable_file_contents"], "files.remote.update": ["preview_image", "indexable_file_contents"] };

const text = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\\_/g, "_")
    .replace(/\s+/g, " ")
    .trim();

async function page(path: string) {
  for (let tries = 0; ; tries++) {
    const res = await fetch(`${DOCS}/${path}.md`);
    if (res.ok) return res.text();
    if (tries === 2) throw new Error(`${path}: ${res.status}`);
    await Bun.sleep(1000);
  }
}

type Arg = { name: string; type?: string; required: boolean; description: string };
function args(md: string): Arg[] {
  const section = md.split("## Arguments")[1]?.split(/^## /m)[0] ?? "";
  return [...section.matchAll(/^\*\*`([^`]+)`\*\*(?:`([^`]*)`)?(Required|Optional)?\n([\s\S]*?)(?=^\*\*`|^### |$(?![\s\S]))/gm)]
    .filter((m) => m[1] !== "token" && /^\w+$/.test(m[1]!))
    .map((m) => {
      const [body = "", ...rest] = m[4]!.trim().split(/_(?:Example|Default):_/);
      const example = /_Example:_\s*`([^`]+)`/.exec(m[4]!)?.[1];
      return { name: m[1]!, type: m[2], required: m[3] === "Required", description: `${text(body).slice(0, 500)}${example && !rest.join("").includes("\n\n\n") ? ` Example: ${example.slice(0, 120)}` : ""}` };
    });
}

function schema(method: string, a: Arg) {
  const fileHint = FILES[method]?.includes(a.name) ? FILE : "";
  const description = `${a.description || BLANK[a.name] || ""}${fileHint}`;
  if (fileHint) return { description };
  switch (a.type) {
    case "boolean":
      return { type: "boolean", description };
    case "integer":
    case "number":
      return { type: a.type, description };
    case "array":
      // Slack calls some comma-separated strings arrays; the rest go as JSON
      return /comma.?separated/i.test(a.description) ? { type: "string", description } : { type: "array", items: {}, description };
    case "object":
      return { type: "object", additionalProperties: {}, description };
    case undefined:
      return { description }; // blocks, attachments: Slack takes the JSON or its text
    default:
      return { type: "string", description };
  }
}

const urls = [...new Set([...(await page("llms-sitemap")).matchAll(/reference\/methods\/([A-Za-z.]+)\.md/g)].map((m) => m[1]!))];

type Doc = { method: string; summary: string; bot: string[]; user: string[]; deprecated: boolean; args: Arg[] };
const scopes = (fm: string, kind: string) => /* e.g.   bot: ["chat:write"] */ JSON.parse(new RegExp(`^  ${kind}: (\\[.*\\])`, "m").exec(fm)?.[1] ?? "[]") as string[];
const docs: Doc[] = [];
for (let i = 0; i < urls.length; i += 12) {
  await Promise.all(
    urls.slice(i, i + 12).map(async (path) => {
      const md = await page(`reference/methods/${path}`);
      const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
      const method = /^method_name: "(.*)"/m.exec(fm)?.[1];
      if (!method) return;
      docs.push({ method, summary: /^summary: "(.*)"/m.exec(fm)?.[1] ?? method, bot: scopes(fm, "bot"), user: scopes(fm, "user"), deprecated: /^\*\*Description\*\*[^\n]*deprecated/im.test(md), args: args(md) });
    }),
  );
}
docs.sort((a, b) => a.method.localeCompare(b.method));

const snake = (m: string) =>
  m
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/\./g, "_")
    .toLowerCase();

const skipped: string[] = [];
const actions: object[] = [];
const botScopes = new Set<string>();
const userScopes = new Set<string>();
for (const d of docs) {
  const why = d.deprecated ? "Slack marks it deprecated" : SKIP.find(([re]) => re.test(d.method))?.[1];
  if (why) {
    skipped.push(`${d.method}: ${why}`);
    continue;
  }
  // bot by default; the person's own login only where Slack gives a bot no way in
  const token = !d.bot.length && d.user.length ? "user" : "bot";
  (token === "bot" ? d.bot : d.user).forEach((s) => (token === "bot" ? botScopes : userScopes).add(s));
  const properties = Object.fromEntries(d.args.map((a) => [a.name, schema(d.method, a)]));
  const required = d.args.filter((a) => a.required).map((a) => a.name);
  const readOnly = READS.test(d.method) && !NOT_READS.has(d.method);
  const note = `${d.method === "conversations.history" || d.method === "conversations.replies" ? LIMITED : ""}${token === "user" ? " Runs as the person who connected Slack." : ""}`;
  for (const name of NAMES[d.method] ?? [snake(d.method)])
    actions.push({ name, method: d.method, token, group: d.method.split(".")[0], description: `${text(d.summary).replace(/\.?$/, ".")}${note}`, readOnly, input: { type: "object", properties, ...(required.length && { required }) } });
}

const out = new URL("../../src/integrations/own/slack/actions.json", import.meta.url).pathname;
await Bun.write(out, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), skipped, actions }));
console.log(`${actions.length} actions, ${skipped.length} skipped → ${out}`);
console.log("bot scopes:", [...botScopes].sort().join(" "));
console.log("user scopes:", [...userScopes].sort().join(" "));

const ours = new Set(actions.map((a) => (a as { name: string }).name));
console.log("Composio names with no action here:", (await composioNames("slack")).filter((n) => !ours.has(n)).join(" "));
for (const [m, n] of Object.entries(NAMES)) if (!docs.some((d) => d.method === m)) console.log("mapped but not in the docs:", m, n);

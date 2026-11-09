// Zoho Mail: every call in its API docs (it has no OpenAPI spec), from `bun scripts/openapi-actions.ts zoho_mail`. Sign-in only.
// accountId and zoid are worked out from the login when left out, the same way as Books' organisation.
import { z } from "zod";
import type { OwnApp } from "../index";
import { type Api, call, rest, specActions } from "../openapi";
import { autoFill, zohoClient, zohoOAuth } from "../zoho-login";

export const SCOPES = "ZohoMail.accounts.ALL,ZohoMail.folders.ALL,ZohoMail.messages.ALL,ZohoMail.tags.ALL,ZohoMail.tasks.ALL,ZohoMail.notes.ALL,ZohoMail.links.ALL,ZohoMail.organization.accounts.ALL,ZohoMail.organization.domains.ALL,ZohoMail.organization.groups.ALL,ZohoMail.organization.policy.ALL,ZohoMail.organization.spam.ALL,ZohoMail.organization.subscriptions.ALL,ZohoMail.organization.audit.ALL";
const api: Api = zohoClient("Zoho Mail", "https://mail.zoho.com");

export const accounts = async (key: string) => {
  const out = (await call(api, key, { method: "GET", path: "/api/accounts", query: [], headers: [] }, {})) as { data?: { accountId: string; mailboxAddress?: string; primaryEmailAddress?: string; accountDisplayName?: string }[] };
  return (out.data ?? []).map((a) => ({ id: String(a.accountId), label: a.mailboxAddress ?? a.primaryEmailAddress ?? a.accountDisplayName ?? String(a.accountId) }));
};
const organisation = async (key: string) => {
  const out = (await call(api, key, { method: "GET", path: "/api/organization", query: [], headers: [] }, {})) as { data?: { zoid?: string | number; companyName?: string } };
  return out.data?.zoid ? [{ id: String(out.data.zoid), label: out.data.companyName ?? "organisation" }] : [];
};

// Mail's one update call for many changes (read, flag, move, label...), Composio's way; each change is also its own action
const updateMessages = rest(api, "PUT", "/api/accounts/{accountId}/updatemessage", "Change emails in one call: mark read or unread, flag, archive, move or label them, by the mode you give.", z.object({
  accountId: z.string().describe("The mailbox (its accountId)"),
  mode: z.string().describe("What to do: markAsRead, markAsUnread, moveToSpam, archiveMails, unarchiveMails, setFlag, moveMessage, applyLabel, removeLabel..."),
  messageId: z.array(z.string()).describe("The ids of the emails to change"),
}).loose());

const generated = await specActions(new URL("./actions.json", import.meta.url), api);
const withAccount = autoFill({ ...generated, messages_update_messages: updateMessages, messages_update_emails: updateMessages, messages_upload_attachments: generated.messages_upload_attachment!, groups_list_moderated_messages: generated.groups_list_moderation_emails! }, {
  field: "accountId",
  what: "mailbox",
  describe: "The mailbox to act on (its accountId). Leave out when the login has just one mailbox; Emplio fills it in.",
  list: accounts,
});
const actions = autoFill(withAccount, {
  field: "zoid",
  what: "organisation",
  describe: "The organisation (its zoid), for admin calls. Leave out; Emplio fills it in.",
  list: organisation,
});

export const zoho_mail: OwnApp = {
  app: "zoho_mail",
  name: "Zoho Mail",
  logo: "/logos/zoho_mail.svg",
  check: async (key) => (await accounts(key)).map((a) => a.label).join(", ") || undefined,
  oauth: zohoOAuth("Zoho Mail", SCOPES),
  actions,
};

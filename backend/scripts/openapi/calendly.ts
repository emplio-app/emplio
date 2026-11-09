// Calendly: what the generator (../openapi-actions.ts) can't tell from the spec. The spec is the one behind
// developer.calendly.com (a Stoplight project).
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const FROM_ME = "Get it from get_current_user";

export default {
  spec: "https://stoplight.io/api/v1/projects/calendly/api-docs/nodes/reference/calendly-api/openapi.yaml",
  out: "src/integrations/own/calendly/actions.json",
  name: namer(await composioNames("calendly")),
  rename: { create_webhook_subscription: "create_webhooks", cancel_event: "cancel_scheduled_event", create_invitee_no_show: "invitee_no_show", invite_user_to_organization: "organization_invitation" },
  params: {
    organization: `The organization's URI, like https://api.calendly.com/organizations/AAAA. ${FROM_ME} (current_organization).`,
    user: `The user's URI, like https://api.calendly.com/users/AAAA. ${FROM_ME} (uri).`,
  },
} satisfies AppConfig;

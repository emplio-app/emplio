// The support team: agents, service accounts and their API keys, skills, roles, groups and agent availability.
import { z } from "zod";
import type { OwnAction } from "../index";
import { id, page, r } from "./client";

const agentId = id("agent", "freshdesk.get_agents");
const groupId = id("group", "freshdesk.list_groups");
const ids = (what: string) => z.array(z.number().int()).optional().describe(what);

const agentFields = {
  email: z.string().optional().describe("Their email (required on create)"),
  name: z.string().optional().describe("Full name"),
  ticket_scope: z.number().int().optional().describe("Tickets they see: 1 all, 2 their groups', 3 only their own (required on create)"),
  occasional: z.boolean().optional().describe("Occasional (day pass) agent instead of full time"),
  role_ids: ids("Roles (freshdesk.list_roles)"),
  group_ids: ids("Groups they're in"),
  contribution_group_ids: ids("Groups they may help on without being in them"),
  skill_ids: ids("Skills (freshdesk.list_all_skills)"),
  signature: z.string().optional().describe("Email signature, HTML"),
  language: z.string().optional().describe("Language code, e.g. en"),
  time_zone: z.string().optional().describe("Time zone"),
  focus_mode: z.boolean().optional().describe("Focus mode on (default true)"),
  agent_type: z.number().int().optional().describe("1 support agent (default), 2 field technician, 3 collaborator"),
};

const skillFields = {
  name: z.string().optional().describe("Skill name (required on create)"),
  rank: z.number().int().optional().describe("Order skills are checked in"),
  agents: z.array(z.object({ id: z.number().int() })).optional().describe('Agents with it, e.g. [{"id": 1}]'),
  match_type: z.enum(["all", "any"]).optional().describe("Whether all or any conditions must match"),
  conditions: z.array(z.record(z.string(), z.any())).optional().describe('Which tickets need it, e.g. [{"resource_type": "ticket", "field_name": "priority", "operator": "in", "value": [3, 4]}]'),
};

const groupFields = {
  name: z.string().optional().describe("Group name (unique; required on create)"),
  description: z.string().optional().describe("What the group does"),
  agent_ids: ids("Agents in it"),
  escalate_to: z.number().int().optional().describe("Agent told when a ticket sits unassigned too long"),
  unassigned_for: z.string().optional().describe('How long before that: "30m", "1h", "2h", "4h", "8h", "12h", "1d", "2d", "3d"'),
  business_hour_id: z.number().int().optional().describe("Business hours it works (freshdesk.get_business_hours)"),
  auto_ticket_assign: z.number().int().optional().describe("Automatic assignment: 0 off, 1 round robin, 2 skill based, 3 load based"),
};
const adminGroupFields = {
  name: groupFields.name,
  description: groupFields.description,
  agent_ids: groupFields.agent_ids,
  escalate_to: groupFields.escalate_to,
  unassigned_for: groupFields.unassigned_for,
  type: z.string().optional().describe('"support_agent_group" (default) or "field_agent_group"'),
  business_calendar_id: z.number().int().optional().describe("Business hours it works"),
  allow_agents_to_change_availability: z.boolean().optional().describe("Agents may set themselves available or not"),
  automatic_agent_assignment: z.record(z.string(), z.any()).optional().describe('e.g. {"enabled": true, "type": "channel_specific", "settings": [{"channel": "ticket", "assignment_type": "round_robin"}]}'),
};

export const teamActions: Record<string, OwnAction> = {
  // ── agents
  currently_authenticated_agent: r("GET", "/agents/me", "Who the connected Freshdesk login is (agent id, name, email, role)."),
  get_agents: r("GET", "/agents", "List agents, with simple filters.", {
    email: z.string().optional().describe("Only the agent with this email"),
    mobile: z.string().optional().describe("Only with this mobile"),
    phone: z.string().optional().describe("Only with this phone"),
    state: z.enum(["fulltime", "occasional"]).optional().describe("Only full-time or occasional agents"),
    ...page,
  }),
  get_agent: r("GET", "/agents/{id}", "One agent.", { id: agentId }),
  search_agents: r("GET", "/agents/autocomplete", "Agents whose name or email starts with some letters.", { term: z.string().min(1).describe("The start of the name or email") }),
  create_agent: r("POST", "/agents", "Add an agent to the helpdesk (an invite email goes to them; uses a paid seat unless occasional).", agentFields, { loose: true }),
  create_multiple_agents: r("POST", "/agents/bulk", "Add many agents at once in the background (answers a job id; freshdesk.get_job tracks it).", {
    agents: z.array(z.record(z.string(), z.any())).min(1).describe('Agents, each like freshdesk.create_agent\'s fields, e.g. [{"email": "sam@northwind.com", "ticket_scope": 1}]'),
  }),
  update_agent: r("PUT", "/agents/{id}", "Change an agent's details, roles or groups. Fields left out stay.", { id: agentId, ...agentFields }, { loose: true }),
  delete_agent: r("DELETE", "/agents/{id}", "Remove an agent; they become a contact.", { id: agentId }),
  list_agents_availability: r("GET", "/agents", "Every agent's availability and ticket load.", { only: z.literal("availability").default("availability").describe('Always "availability"'), ...page }),
  get_agent_availability: r("GET", "/agents/{id}/availability", "Whether an agent is available, and their ticket limits per channel.", { id: agentId }),
  update_agent_availability: r("PUT", "/agents/{id}/availability", "Set an agent's ticket limits per channel and who controls their availability.", {
    id: agentId,
    channel_availability: z.array(z.record(z.string(), z.any())).optional().describe('e.g. [{"channel": "Email queue", "assignment_limit": 20, "available": true}]'),
    availability_control: z.string().optional().describe('"agent_controlled" or "admin_controlled"'),
  }, { loose: true }),

  // ── service accounts (non-human agents for integrations) and API keys
  create_service_account: r("POST", "/agents", "Make a service account: a non-human agent with its own API keys, using no paid seat. The answer holds the new API key.", {
    name: z.string().min(1).describe("Its name, e.g. Billing sync"),
    agent_type: z.literal(8).default(8).describe("Always 8 (service account)"),
    api_key_settings: z.record(z.string(), z.any()).describe('e.g. {"keys": [{"position": 1, "enabled": true, "ttl_days": 90}]}'),
    description: z.string().optional().describe("What it's for"),
    ticket_scope: agentFields.ticket_scope,
    role_ids: agentFields.role_ids,
    group_ids: agentFields.group_ids,
  }, { loose: true }),
  list_api_keys: r("GET", "/agents/{id}/api_keys", "A service account's API keys (not their values).", { id: agentId }),
  create_api_key: r("POST", "/agents/{id}/api_keys", "Make an API key for a service account, or start rotating one (a second key in the other position). The answer holds the key.", {
    id: agentId,
    position: z.number().int().min(1).max(2).describe("Key slot, 1 or 2"),
    enabled: z.boolean().optional().describe("On straight away (default true)"),
    ttl_days: z.number().int().optional().describe("Days until it expires"),
  }),
  view_api_key: r("GET", "/agents/{id}/api_keys/{api_key_id}", "One API key's details (not its value).", { id: agentId, api_key_id: z.string().min(1).describe("Key id (freshdesk.list_api_keys)") }),
  update_api_key: r("PATCH", "/agents/{id}/api_keys/{api_key_id}", "Turn a service account's API key on or off.", {
    id: agentId,
    api_key_id: z.string().min(1).describe("Key id (freshdesk.list_api_keys)"),
    enabled: z.boolean().describe("true on, false off"),
  }),
  delete_api_key: r("DELETE", "/agents/{id}/api_keys/{api_key_id}", "Delete a service account's API key.", { id: agentId, api_key_id: z.string().min(1).describe("Key id") }),
  rotate_api_key: r("POST", "/agents/{id}/api_keys/{api_key_id}/rotate", "Finish a key rotation: the old key stops and the new one takes over.", { id: agentId, api_key_id: z.string().min(1).describe("The old key's id") }),

  // ── skills
  list_all_skills: r("GET", "/admin/skills", "Skills used to route tickets to the right agents."),
  view_skill: r("GET", "/admin/skills/{id}", "One skill and its conditions.", { id: id("skill") }),
  create_skill: r("POST", "/admin/skills", "Add a skill: which tickets need it and which agents have it.", skillFields, { loose: true }),
  update_skill: r("PUT", "/admin/skills/{id}", "Change a skill.", { id: id("skill"), ...skillFields }, { loose: true }),
  delete_skill: r("DELETE", "/admin/skills/{id}", "Delete a skill.", { id: id("skill") }),

  // ── roles
  list_roles: r("GET", "/roles", "Agent roles (what each kind of agent may do)."),
  view_role: r("GET", "/roles/{id}", "One role.", { id: id("role") }),

  // ── groups
  list_groups: r("GET", "/groups", "Agent groups (teams tickets are assigned to).", page),
  view_group: r("GET", "/groups/{id}", "One group and its agents.", { id: groupId }),
  create_group: r("POST", "/groups", "Add an agent group (also how a field service group is made).", groupFields, { loose: true }),
  update_group: r("PUT", "/groups/{id}", "Change a group. Fields left out stay; agent_ids replaces the members.", { id: groupId, ...groupFields }, { loose: true }),
  delete_group: r("DELETE", "/groups/{id}", "Delete a group.", { id: groupId }),
  // newer group settings (accounts on the 2021 groups page)
  list_admin_groups: r("GET", "/admin/groups", "Agent groups with their newer settings (automatic assignment per channel, business hours).", page),
  view_admin_group: r("GET", "/admin/groups/{id}", "One group with its newer settings.", { id: groupId }),
  create_admin_group: r("POST", "/admin/groups", "Add an agent group with the newer settings.", adminGroupFields, { loose: true }),
  update_admin_group: r("PUT", "/admin/groups/{id}", "Change a group's newer settings.", { id: groupId, ...adminGroupFields }, { loose: true }),
  delete_admin_group: r("DELETE", "/admin/groups/{id}", "Delete a group.", { id: groupId }),
  list_all_agents_in_a_group: r("GET", "/admin/groups/{id}/agents", "Agents in a group.", { id: groupId, ...page }),
  patch_admin_groups_agents: r("PATCH", "/admin/groups/{id}/agents", "Add agents to a group or take them out.", {
    id: groupId,
    agents: z.array(z.object({ id: z.number().int(), deleted: z.boolean().optional() })).min(1).describe('e.g. [{"id": 16}, {"id": 14, "deleted": true}] adds 16 and removes 14'),
  }),
};

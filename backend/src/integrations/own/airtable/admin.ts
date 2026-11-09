// Running a base or workspace: who has access, shared links, interfaces and extensions. Most of these need an Enterprise plan.
import { z } from "zod";
import type { OwnAction } from "../index";
import { baseId, include, r, withList } from "./client";

const base = { base_id: baseId };
const workspace = { workspace_id: z.string().min(1).describe("The workspace's id, starting wsp... (from its web address)") };
const iface = { ...base, interface_id: z.string().min(1).describe("The interface's id, starting pbd... (airtable.get_base_collaborators with interfaces)") };
const who = { user_or_group_id: z.string().min(1).describe("The person's id (usr...) or group's id (ugp...)") };
const level = z.string().min(1).describe('The access: "read", "comment", "edit" or "create"');
const people = z.array(z.record(z.string(), z.any())).min(1).describe('Who and with what access: [{"user": {"id": "usr..."}, "permissionLevel": "edit"}], or {"group": {"id": "ugp..."}, ...}');
const portal = z.array(z.object({ email: z.string(), permissionLevel: z.enum(["read", "comment", "edit"]) })).min(1).describe("Outside people, by email");
const state = (what: string) => z.enum(["enabled", "disabled"]).describe(`Whether ${what} is on`);
const collaborator = { collaborator_id: z.string().min(1).describe("The portal collaborator's id, from airtable.list_base_portal_collaborators") };
const invite = { invite_id: z.string().min(1).describe("The invite's id, from the collaborators answer") };

export const adminActions: Record<string, OwnAction> = {
  get_base_collaborators: withList("GET", "/v0/meta/bases/{base_id}", "Who has access to a base, and its invites and interfaces (Enterprise plan).", { ...base, include: include(["collaborators", "inviteLinks", "interfaces", "packages"]) }, "include", true),
  add_base_collaborator: r("POST", "/v0/meta/bases/{base_id}/collaborators", "Give someone access to a base (one at a time).", { ...base, collaborators: people }),
  update_base_collaborator: r("PATCH", "/v0/meta/bases/{base_id}/collaborators/{user_or_group_id}", "Change someone's access to a base.", { ...base, ...who, permissionLevel: level }),
  delete_base_collaborator: r("DELETE", "/v0/meta/bases/{base_id}/collaborators/{user_or_group_id}", "Remove someone's access to a base.", { ...base, ...who }),
  delete_base_invite: r("DELETE", "/v0/meta/bases/{base_id}/invites/{invite_id}", "Cancel an invite to a base.", { ...base, ...invite }),
  list_base_portal_collaborators: r("GET", "/v0/meta/bases/{base_id}/portalCollaborators", "Outside people with access to the base's interfaces through its portal.", base),
  delete_base_portal_collaborator: r("DELETE", "/v0/meta/bases/{base_id}/portalCollaborators/{collaborator_id}", "Remove an outside person from the base's portal.", { ...base, ...collaborator }),
  list_shares: r("GET", "/v0/meta/bases/{base_id}/shares", "A base's shared links.", base),
  manage_share: r("PATCH", "/v0/meta/bases/{base_id}/shares/{share_id}", "Turn a shared link on or off.", { ...base, share_id: z.string().min(1).describe("The link's id, from airtable.list_shares"), state: state("the link") }),
  delete_share: r("DELETE", "/v0/meta/bases/{base_id}/shares/{share_id}", "Delete a shared link.", { ...base, share_id: z.string().min(1).describe("The link's id, from airtable.list_shares") }),
  list_block_installations: r("GET", "/v0/meta/bases/{base_id}/blockInstallations", "The extensions installed in a base.", base),
  manage_block_installation: r("PATCH", "/v0/meta/bases/{base_id}/blockInstallations/{installation_id}", "Turn an extension on or off.", { ...base, installation_id: z.string().min(1).describe("Its id, from airtable.list_block_installations"), state: state("the extension") }),
  delete_block_installation: r("DELETE", "/v0/meta/bases/{base_id}/blockInstallations/{installation_id}", "Remove an extension from a base.", { ...base, installation_id: z.string().min(1).describe("Its id, from airtable.list_block_installations") }),

  // ── interfaces
  get_interface: withList("GET", "/v0/meta/bases/{base_id}/interfaces/{interface_id}", "An interface and who has access to it.", { ...iface, include: include(["collaborators", "inviteLinks"]) }, "include", true),
  add_interface_collaborator: r("POST", "/v0/meta/bases/{base_id}/interfaces/{interface_id}/collaborators", "Give someone access to an interface.", { ...iface, collaborators: people }),
  update_interface_collaborator: r("PATCH", "/v0/meta/bases/{base_id}/interfaces/{interface_id}/collaborators/{user_or_group_id}", "Change someone's access to an interface.", { ...iface, ...who, permissionLevel: level }),
  delete_interface_collaborator: r("DELETE", "/v0/meta/bases/{base_id}/interfaces/{interface_id}/collaborators/{user_or_group_id}", "Remove someone's access to an interface.", { ...iface, ...who }),
  delete_interface_invite: r("DELETE", "/v0/meta/bases/{base_id}/interfaces/{interface_id}/invites/{invite_id}", "Cancel an invite to an interface.", { ...iface, ...invite }),
  add_interface_portal_collaborators: r("POST", "/v0/meta/bases/{base_id}/interfaces/{interface_id}/portalCollaborators", "Give outside people access to an interface through the base's portal.", { ...iface, collaborators: portal }),
  update_interface_portal_collaborator: r("PATCH", "/v0/meta/bases/{base_id}/interfaces/{interface_id}/portalCollaborators/{collaborator_id}", "Change an outside person's access to an interface.", { ...iface, ...collaborator, permissionLevel: z.enum(["read", "comment", "edit"]).describe("The access") }),
  delete_interface_portal_collaborator: r("DELETE", "/v0/meta/bases/{base_id}/interfaces/{interface_id}/portalCollaborators/{collaborator_id}", "Remove an outside person from an interface.", { ...iface, ...collaborator }),

  // ── workspaces
  get_workspace_collaborators: withList("GET", "/v0/meta/workspaces/{workspace_id}", "Who has access to a workspace, and its bases and invites.", { ...workspace, include: include(["collaborators", "inviteLinks"]) }, "include", true),
  delete_workspace: r("DELETE", "/v0/meta/workspaces/{workspace_id}", "Delete a workspace (Enterprise admin). It must have no bases left.", workspace),
  add_workspace_collaborator: r("POST", "/v0/meta/workspaces/{workspace_id}/collaborators", "Give someone access to a workspace (one at a time).", { ...workspace, collaborators: people }),
  update_workspace_collaborator: r("PATCH", "/v0/meta/workspaces/{workspace_id}/collaborators/{user_or_group_id}", "Change someone's access to a workspace.", { ...workspace, ...who, permissionLevel: level }),
  delete_workspace_collaborator: r("DELETE", "/v0/meta/workspaces/{workspace_id}/collaborators/{user_or_group_id}", "Remove someone's access to a workspace.", { ...workspace, ...who }),
  delete_workspace_invite: r("DELETE", "/v0/meta/workspaces/{workspace_id}/invites/{invite_id}", "Cancel an invite to a workspace.", { ...workspace, ...invite }),
  move_base: r("POST", "/v0/meta/workspaces/{workspace_id}/moveBase", "Move a base into another workspace.", { ...workspace, baseId, targetWorkspaceId: z.string().min(1).describe("The workspace to move it to"), targetIndex: z.number().int().optional().describe("Its place in that workspace (default last)") }),
  update_workspace_restrictions: r("POST", "/v0/meta/workspaces/{workspace_id}/updateRestrictions", "Set who may invite people to, or share from, a workspace.", {
    ...workspace,
    inviteCreationRestriction: z.enum(["unrestricted", "onlyOwners"]).optional().describe("Who may invite people"),
    shareCreationRestriction: z.enum(["unrestricted", "onlyOwners"]).optional().describe("Who may make shared links"),
  }),
};

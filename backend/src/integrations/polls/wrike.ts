// Wrike things its webhooks don't report: new people in the account and new spaces. Tasks, folders, projects,
// comments, files, time and approvals come by webhook (own/wrike/triggers.ts).
import { z } from "zod";
import type { PollTrigger, Run } from "./index";

const rows = (out: unknown) => ((out as { data?: unknown[] | null })?.data ?? []) as any[];

// ponytail: Wrike gives neither a join date nor a creation date here, so every current id is kept in seen; fine for accounts of a few thousand
const listed = (description: string, field: string, what: string, list: (run: Run) => Promise<any[]>): PollTrigger => ({
  description,
  config: z.object({}),
  output: [{ name: field, type: "object", required: true, description: what }],
  every: 15,
  min: 5,
  poll: async (_c, run) => (await list(run)).map((row) => ({ id: String(row.id), item: { [field]: row } })),
});

export const wrike: Record<string, PollTrigger> = {
  new_user: listed(
    "Someone joins the Wrike account (checked every 15 minutes).",
    "user",
    "The person: id, firstName, lastName, profiles (email, role), title, companyName",
    async (run) => rows(await run("wrike.get_contacts", { types: ["Person"], deleted: false })),
  ),
  new_space: listed(
    "A space is created in Wrike, one the connected user can see (checked every 15 minutes).",
    "space",
    "The space: id, title, accessType, description, avatarUrl",
    async (run) => rows(await run("wrike.list_spaces", {})),
  ),
};

// Typeform things its webhooks don't report: forms being made or changed. Responses come by webhook
// (own/typeform/triggers.ts).
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

type Form = { id: string; title?: string; created_at?: string; last_updated_at?: string };
const FORM = [{ name: "form", type: "object", required: true, description: "The form: id, title, created_at, last_updated_at, settings, _links.display (its public link)" }];
// ponytail: the newest 200 forms only; more made or changed between two checks are missed
const forms = async (sort: string, run: Run) =>
  (((await run("typeform.list_forms", { page_size: 200, sort_by: sort, order_by: "desc" })) as { items?: Form[] })?.items ?? []);

export const typeform: Record<string, PollTrigger> = {
  new_form: {
    description: "A form was made in Typeform (checked every 5 minutes).",
    config: z.object({}),
    output: FORM,
    every: 5,
    min: 1,
    poll: async (_c, run) => (await forms("created_at", run)).filter((f) => recent(f.created_at)).map((f) => ({ id: f.id, item: { form: f } })),
  },
  form_updated: {
    description: "A Typeform form was changed: its questions, title or settings (checked every 5 minutes). A run that edits the same form starts this again, so say in the prompt when to stop.",
    config: z.object({}),
    output: FORM,
    every: 5,
    min: 1,
    poll: async (_c, run) =>
      (await forms("last_updated_at", run)).filter((f) => recent(f.last_updated_at) && f.last_updated_at !== f.created_at).map((f) => ({ id: `${f.id}:${f.last_updated_at}`, item: { form: f } })),
  },
};

// Triggers we run ourselves by polling, the way n8n does: every few minutes the server calls one of the
// app's actions (through the person's connection, like any action) and compares with what it saw last
// time. Only new items start the automation, so the AI employee isn't woken just to look. Works for any
// provider's app. Listed ahead of the provider's own triggers, so one here replaces theirs of the same name.
// Add one: write polls/<app>.ts (copy todoist.ts) whose poll() returns the current items, each with an id
// that never changes, and list it in APPS. The timer, seen-items, first check, `every` setting and
// `emplio automations triggers` listing all come from here.
import type { ActionDetail, ActionInfo } from "@emplio/shared";
import { z } from "zod";
import type { TriggerDetail } from "../types";
import { airtable } from "./airtable";
import { notion } from "./notion";
import { github } from "./github";
import { googlecalendar } from "./googlecalendar";
import { googledocs } from "./googledocs";
import { googlemeet } from "./googlemeet";
import { googlesheets } from "./googlesheets";
import { hubspot } from "./hubspot";
import { indiamart } from "./indiamart";
import { razorpay } from "./razorpay";
import { swipe } from "./swipe";
import { todoist } from "./todoist";
import { zoho } from "./zoho";
import { zoho_books } from "./zoho_books";
import { zoho_invoice } from "./zoho_invoice";
import { zoho_mail } from "./zoho_mail";

export type Run = (action: string, input: unknown) => Promise<unknown>;
export type PollTrigger = {
  description: string;
  // its settings (config: in the automation file); `every` (minutes) is added to all
  config: z.ZodObject;
  // what each event carries, for the prompt writer
  output: ActionDetail["input"];
  // minutes between polls: the default, and the least allowed (rate limits)
  every: number;
  min: number;
  // the items there now (only recent ones, so the seen list stays short), each with an id that never changes
  poll(config: any, run: Run): Promise<{ id: string; item: unknown }[]>;
};

// Every app's polled triggers, one file per app (polls/<app>.ts), each exporting its triggers by short name.
const APPS: Record<string, Record<string, PollTrigger>> = { todoist, indiamart, razorpay, swipe, github, hubspot, notion, airtable, googlecalendar, googledocs, googlesheets, googlemeet, zoho_books, zoho_invoice, zoho_mail, zoho };
const POLLS: Record<string, PollTrigger> = Object.fromEntries(
  Object.entries(APPS).flatMap(([app, triggers]) => Object.entries(triggers).map(([name, t]) => [`${app}.${name}`, t])),
);

// for poll(): keeps only items from the last day, so the seen list stays short
export const recent = (iso: unknown) => typeof iso === "string" && Date.now() - Date.parse(iso) < 86_400_000;

export const pollTrigger = (trigger: string) => POLLS[trigger];

export const listPolls = (app: string): ActionInfo[] =>
  Object.entries(POLLS)
    .filter(([name]) => name.startsWith(`${app}.`))
    .map(([action, p]) => ({ action, description: p.description }));

export function pollDetail(trigger: string): TriggerDetail | null {
  const p = POLLS[trigger];
  if (!p) return null;
  const schema = z.toJSONSchema(p.config, { io: "input" }) as { properties?: Record<string, any>; required?: string[] };
  return {
    action: trigger,
    app: trigger.split(".")[0]!,
    description: p.description,
    input: [
      { name: "every", type: "number", required: false, description: `Minutes between checks (default ${p.every}, at least ${p.min})` },
      ...Object.entries(schema.properties ?? {}).map(([name, s]) => ({
        name,
        type: s.type === "array" ? `${s.items?.type ?? "any"}[]` : (s.type ?? "any"),
        required: schema.required?.includes(name) ?? false,
        description: s.description ?? "",
      })),
    ],
    output: p.output,
  };
}

// The settings checked, with `every` split off; throws a message for the person if they're wrong.
export function pollConfig(trigger: string, config: unknown) {
  const p = POLLS[trigger]!;
  const { every = p.every, ...rest } = (config ?? {}) as { every?: unknown };
  if (typeof every !== "number" || every < p.min) throw new Error(`every: must be a number of minutes, at least ${p.min}`);
  const parsed = p.config.safeParse(rest);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; "));
  return { every, config: parsed.data };
}

// What's new since last time. `seen` null is the first poll: it only notes what's there (n8n does the
// same), so turning an automation on doesn't fire for every existing item.
// ponytail: seen ids kept to the last 1000; items poll() returns stay recent (a day), so that's plenty
export async function pollOnce(trigger: string, config: unknown, seen: string[] | null, run: Run) {
  const p = POLLS[trigger]!;
  const items = await p.poll(config, run);
  const known = new Set(seen ?? []);
  const fresh = seen ? items.filter((i) => !known.has(i.id)) : [];
  const ids = [...new Set([...items.map((i) => i.id), ...(seen ?? [])])].slice(0, 1000);
  return { fresh: fresh.map((i) => i.item), seen: ids };
}

if (import.meta.main) {
  const tasks = (ids: string[], labels = ["x"]) => async () => ({ tasks: ids.map((id) => ({ id, labels, added_at: new Date().toISOString() })) });
  const first = await pollOnce("todoist.new_task", {}, null, tasks(["a", "b"]));
  console.assert(first.fresh.length === 0 && first.seen.length === 2, "first poll only notes");
  const second = await pollOnce("todoist.new_task", {}, first.seen, tasks(["a", "b", "c"]));
  console.assert(second.fresh.length === 1 && (second.fresh[0] as any).task.id === "c", "new task found");
  const third = await pollOnce("todoist.new_task", { labels: ["y"] }, second.seen, tasks(["a", "b", "c", "d"]));
  console.assert(third.fresh.length === 0, "label filter");
  console.assert(pollConfig("indiamart.new_lead", { every: 5 }).every === 5, "every ok");
  let threw = false;
  try {
    pollConfig("indiamart.new_lead", { every: 1 });
  } catch {
    threw = true;
  }
  console.assert(threw, "every below min refused");
  console.log("polls ok");
}

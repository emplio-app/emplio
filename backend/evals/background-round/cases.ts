// The rounds the background agent is checked against. Between chats it gets the readers' notes and has to put each
// thing where it belongs, so the next chat is better: a way of doing a job into a skill, a fact into knowledge, a
// preference onto the person, a promise into a task. Add a case each time a note led nowhere (rewritten: these are
// sent to Braintrust).

// What each case is there to catch:
// - skill: a way that was worked out or repeated, and no skill saved in the chat. This is the catch-up for it.
// - knowledge, preference, task: the same for facts, preferences and promises.
// - nothing: no notes. Saving things anyway is noise.
export type Category = "skill" | "knowledge" | "preference" | "task" | "nothing";
export type Does = "skill" | "knowledge" | "preference" | "task";

export type Case = {
  name: string;
  category: Category;
  source: "real" | "written";
  // the readers' notes, as the round gets them (src/reader.ts noteLine)
  notes: string;
  // everything in `does` must be done; for "nothing", none of the four may be
  expect: { does: Does[] };
};

const note = (title: string, text: string) => `[10 Nov, 4:10 pm] Meera, chat 3f9a12bc "${title}":\n${text}`;

export const cases: Case[] = [
  {
    name: "a job done twice with no skill",
    category: "skill",
    source: "written",
    notes: note("Packing slips", "Repeated: Meera needs a packing slip for every order going out; made for 4410 and 4417 with /work/tmp/slip/make.py <order number>, which reads the order from Zoho and writes a PDF.\nWay: packing slip = run make.py with the order number; no skill saved for it."),
    expect: { does: ["skill"] },
  },
  {
    name: "a corrected way",
    category: "skill",
    source: "written",
    notes: note("Amazon payouts", "Way: to match Amazon payouts to the orders sheet, first add back Amazon's fee and 1% TCS from the fee columns, then match. Meera corrected this; the first try without it left 21 of 118 unmatched."),
    expect: { does: ["skill"] },
  },
  { name: "a fact", category: "knowledge", source: "written", notes: note("Shop timing", "Fact: shop timing changes to 10:30 to 8:30, closed Sundays, from 15 Nov."), expect: { does: ["knowledge"] } },
  { name: "a supplier's terms", category: "knowledge", source: "written", notes: note("New supplier", "Fact: cushion fillers now come from Shree Foam, ₹92 a kg, 30 days' credit."), expect: { does: ["knowledge"] } },
  {
    name: "a preference",
    category: "preference",
    source: "written",
    notes: note("Customer messages", "Preference: Meera wants no emojis in customer messages, ever, and every one signed Kaveri Home Furnishings."),
    expect: { does: ["preference"] },
  },
  {
    name: "a promise with no task",
    category: "task",
    source: "written",
    notes: note("Blue Lotus invoice", "Promise: the AI said it will check on Friday 13 Nov whether Blue Lotus Cafe paid invoice 215 (₹31,750) and remind them if not; no task was added."),
    expect: { does: ["task"] },
  },
  {
    name: "a fact and a promise in one chat",
    category: "task",
    source: "written",
    notes: note("New supplier", "Fact: cushion fillers moved to Shree Foam, ₹92 a kg, 30 days' credit.\nPromise: Raj will send Shree Foam the first PO by Wednesday 11 Nov; no task was added."),
    expect: { does: ["knowledge", "task"] },
  },
  {
    name: "two chats, three kinds",
    category: "skill",
    source: "written",
    notes: [
      note("Amazon payouts", "Way: match Amazon payouts only after adding back the fee and 1% TCS from the fee columns; corrected by Meera."),
      note("Customer messages", "Preference: Meera wants no emojis in customer messages."),
      note("Shop timing", "Fact: shop closed on Sundays from 15 Nov."),
    ].join("\n\n"),
    expect: { does: ["skill", "preference", "knowledge"] },
  },
  { name: "no notes", category: "nothing", source: "written", notes: "(nothing)", expect: { does: [] } },
];

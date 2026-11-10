// The chats the reader is checked against. The reader goes through each chat afterwards and tells the background
// agent what's worth keeping; if it misses something, Emplio never learns it. Add a case each time something a
// person said was lost (rewritten: these are sent to Braintrust).

// What can go wrong, and so what each case is there to catch:
// - notice: a way of doing a job, a fact, a preference, a promise, something that failed, work done by hand. Missing
//   it means it's never saved.
// - nothing: small talk, a one-off answered fine. A note for it wastes the background agent's round.
export type Category = "notice" | "nothing";

export type Case = {
  name: string;
  category: Category;
  source: "real" | "written";
  title: string;
  // the new part of the chat, as the reader gets it (src/reader.ts transcript)
  chat: string;
  // kinds: for each list, a line of one of those kinds must be there. silent: nothing to report.
  expect: { silent: boolean; kinds?: string[][] };
};

const p = (text: string) => `### Person\n${text}`;
const e = (text: string) => `### AI employee\n${text}`;
const chat = (...turns: string[]) => turns.join("\n\n");

export const cases: Case[] = [
  // ── notice ─────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "a job done a second time, no skill saved",
    category: "notice",
    source: "written",
    title: "Packing slips",
    chat: chat(
      p("make a packing slip for order 4410"),
      e("$ python3 /work/tmp/slip/make.py 4410\nSaved /work/out/packing-slip-4410.pdf\n\nPacking slip for order 4410 is ready."),
      p("good. now one for 4417 too. i'll need these for every order going out"),
      e("$ python3 /work/tmp/slip/make.py 4417\nSaved /work/out/packing-slip-4417.pdf\n\nPacking slip for order 4417 is ready."),
    ),
    expect: { silent: false, kinds: [["Way", "Repeated"]] },
  },
  {
    name: "corrected on how to do a job",
    category: "notice",
    source: "written",
    title: "Amazon payouts",
    chat: chat(
      p("match october's amazon payouts against our orders sheet"),
      e("97 of 118 payouts match the orders sheet; 21 differ in amount."),
      p("no thats wrong. amazon cuts their fee and 1% TCS before paying. add those back from the fee columns and then match. always do it that way"),
      e("With the fee and TCS added back, all 118 October payouts match."),
    ),
    expect: { silent: false, kinds: [["Way", "Preference"]] },
  },
  {
    name: "a business fact",
    category: "notice",
    source: "written",
    title: "Shop timing",
    chat: chat(p("our new shop timing is 10:30 to 8:30, sundays closed, from 15 nov"), e("Noted: 10:30 to 8:30, closed Sundays, from 15 November.")),
    expect: { silent: false, kinds: [["Fact"]] },
  },
  {
    name: "a preference",
    category: "notice",
    source: "written",
    title: "Customer messages",
    chat: chat(p("write a msg to anita that her order is ready"), e("Hi Anita! 🎉 Your order is ready for pickup."), p("no emojis in customer messages. ever. and always say Kaveri Home Furnishings at the end")),
    expect: { silent: false, kinds: [["Preference"]] },
  },
  {
    name: "a promise with no task",
    category: "notice",
    source: "written",
    title: "Blue Lotus invoice",
    chat: chat(p("did blue lotus cafe pay"), e("Not yet: invoice 215 for ₹31,750 is 11 days late. I'll check again on Friday and remind them if it's still open.")),
    expect: { silent: false, kinds: [["Promise"]] },
  },
  {
    name: "something it couldn't do",
    category: "notice",
    source: "written",
    title: "Bank statement",
    chat: chat(p("download my september bank statement"), e("I couldn't get it: the bank's site kept logging me out after the OTP, three times. Could you download it and send it to me?")),
    expect: { silent: false, kinds: [["Couldn't"]] },
  },
  {
    name: "work done by hand every week",
    category: "notice",
    source: "written",
    title: "Sales numbers",
    chat: chat(p("whats the total of column D in the sales sheet"), e("Column D totals ₹4,86,200."), p("ok. every monday i copy these from zoho into this sheet by hand, takes me an hour")),
    expect: { silent: false, kinds: [["Repeated"]] },
  },
  {
    name: "a fact and a promise together",
    category: "notice",
    source: "written",
    title: "New supplier",
    chat: chat(p("we've moved cushion fillers to Shree Foam, 92 rs a kg, 30 days credit. raj will send them the first PO by wednesday"), e("Got it: Shree Foam for cushion fillers at ₹92 a kg with 30 days' credit.")),
    expect: { silent: false, kinds: [["Fact"], ["Promise"]] },
  },

  // ── nothing ────────────────────────────────────────────────────────────────────────────────────────────────────
  { name: "hello and thanks", category: "nothing", source: "written", title: "Quick hello", chat: chat(p("hi"), e("Hi Meera! What can I take off your plate?"), p("nothing now, thanks")), expect: { silent: true } },
  { name: "a sum", category: "nothing", source: "written", title: "GST sum", chat: chat(p("whats 18% gst on 4500"), e("₹810, so ₹5,310 in all.")), expect: { silent: true } },
  {
    name: "a one-off translation",
    category: "nothing",
    source: "written",
    title: "Marathi line",
    chat: chat(p("translate to marathi: happy diwali to you and your family"), e("तुम्हाला आणि तुमच्या कुटुंबाला दिवाळीच्या हार्दिक शुभेच्छा")),
    expect: { silent: true },
  },
  { name: "a general question", category: "nothing", source: "written", title: "Curtain types", chat: chat(p("difference between blackout and dimout curtains?"), e("Blackout blocks nearly all light; dimout blocks most of it and hangs softer.")), expect: { silent: true } },
];

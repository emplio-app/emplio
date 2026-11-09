// The chats the card writer is checked against. Each ends on Emplio's reply and says what should happen next:
// a card, or nothing. Add a case every time a wrong card is seen in a real chat (rewrite it so no customer's
// names or numbers go in: these are sent to Braintrust).
import type { Turn } from "../../src/next-step";

// What can go wrong, and so what each case is there to catch:
// - typing: the question can only be answered by typing something, so there must be no card
// - nothing: the work is done, still under way, or it was small talk, so there must be no card
// - decision: a yes/no the person can settle with a tap, so there must be a card
// - options: the reply named the choices, so the card must offer those
export type Category = "typing" | "nothing" | "decision" | "options";

export type Case = {
  name: string;
  category: Category;
  // real: seen in a real chat (rewritten). written: made up to cover a kind of chat we haven't caught yet
  source: "real" | "written";
  chat: Turn[];
  // offers: words the buttons must carry, one per named choice. devanagari: the card must be in that script
  expect: { card: boolean; offers?: string[]; devanagari?: boolean };
};

const u = (text: string): Turn => ({ role: "user", text });
const e = (text: string): Turn => ({ role: "assistant", text });

export const cases: Case[] = [
  // ── typing: no card ────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "which repo to watch",
    category: "typing",
    source: "real",
    chat: [
      u("how can i get star notification on github"),
      e(
        'GitHub has no built-in star notification, so you need a small workaround:\n\n- **Webhook:** go to Repo → Settings → Webhooks → choose the **Watch** event, which fires on a new star. Point it at Slack, Discord, Zapier or Make to get a ping.\n- **Ready-made apps:** a "GitHub star notifier" app or Zapier\'s "New Star" trigger can email or message you.\n\nI can set up a daily email or phone summary of new stars on your repos if you\'d like. Which repo should it watch?',
      ),
    ],
    expect: { card: false },
  },
  {
    name: "customer's email address",
    category: "typing",
    source: "written",
    chat: [
      u("send the quotation for 40 chairs to the new customer from yesterday"),
      e("The quotation for 40 chairs is ready as a PDF. I don't have an email address for them yet. What's their email?"),
    ],
    expect: { card: false },
  },
  {
    name: "invoice amount",
    category: "typing",
    source: "written",
    chat: [u("make an invoice for Sharma Traders for the website work"), e("I can make that invoice for Sharma Traders. What amount should it be for, and is GST on top or included?")],
    expect: { card: false },
  },
  {
    name: "what day for the meeting",
    category: "typing",
    source: "written",
    chat: [
      u("set up a meeting with the accountant about the quarterly filing"),
      e("I'll set that up with your accountant. Which day and time next week works for you?"),
    ],
    expect: { card: false },
  },
  {
    name: "needs the logo file",
    category: "typing",
    source: "written",
    chat: [
      u("make a letterhead for the clinic"),
      e("Happy to design the clinic's letterhead. Please send me the logo file and the address you want printed on it."),
    ],
    expect: { card: false },
  },
  {
    name: "what the message should say",
    category: "typing",
    source: "written",
    chat: [
      u("message all the staff on whatsapp about diwali"),
      e("I can message all 12 staff members. What would you like the message to say?"),
    ],
    expect: { card: false },
  },
  {
    name: "link to the sheet",
    category: "typing",
    source: "written",
    chat: [
      u("can you clean up my stock sheet, it has lots of duplicates"),
      e("Yes, I can remove the duplicates and tidy the columns. Share the link to the stock sheet and I'll get started."),
    ],
    expect: { card: false },
  },
  {
    name: "draft ready but no recipient",
    category: "typing",
    source: "written",
    chat: [
      u("write a payment reminder for the overdue invoice 114"),
      e("Here's the reminder:\n\n> Hi, a gentle reminder that invoice 114 for ₹48,000 was due on the 2nd. Could you let us know when we can expect payment?\n\nWho should I send it to? I don't have a contact saved for this invoice."),
    ],
    expect: { card: false },
  },
  {
    name: "how many and what budget",
    category: "typing",
    source: "written",
    chat: [
      u("order new t-shirts for the team"),
      e("Sure. How many do you need, and what's the budget per shirt? Once I know that I'll get quotes from three printers."),
    ],
    expect: { card: false },
  },
  {
    name: "offer plus an open question",
    category: "typing",
    source: "written",
    chat: [
      u("i keep forgetting to follow up with leads"),
      e("That's easy to fix. I can check your leads every morning and remind you who hasn't replied in three days. Where do you keep your leads right now?"),
    ],
    expect: { card: false },
  },
  {
    name: "which customers get the offer",
    category: "typing",
    source: "written",
    chat: [
      u("send the diwali discount to our customers"),
      e("The Diwali discount message is ready. Which customers should get it? You have 1,240 on the list."),
    ],
    expect: { card: false },
  },
  {
    name: "a yes/no and a name together",
    category: "typing",
    source: "written",
    chat: [
      u("book a table at Sarovar for friday dinner, 6 people"),
      e("Sarovar has a table for six at 8 PM on Friday. Should I book it, and what name should the booking be under?"),
    ],
    expect: { card: false },
  },

  // ── nothing: no card ───────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "thanks",
    category: "nothing",
    source: "written",
    chat: [u("send the invoice to Acme"), e("Sent. Acme has invoice 212 for ₹18,500 in their inbox."), u("great thanks"), e("You're welcome!")],
    expect: { card: false },
  },
  {
    name: "hello",
    category: "nothing",
    source: "written",
    chat: [u("hi"), e("Hi! What can I take off your plate today?")],
    expect: { card: false },
  },
  {
    name: "work finished",
    category: "nothing",
    source: "written",
    chat: [
      u("remind me every monday at 9 to check the bank balance"),
      e("Done. Every Monday at 9:00 AM I'll remind you to check the bank balance, starting this coming Monday."),
    ],
    expect: { card: false },
  },
  {
    name: "plain fact",
    category: "nothing",
    source: "written",
    chat: [u("what's the gst rate on restaurant food"), e("Restaurant food is charged 5% GST, with no input tax credit. Restaurants inside hotels with rooms above ₹7,500 a night charge 18%.")],
    expect: { card: false },
  },
  {
    name: "still working on it",
    category: "nothing",
    source: "written",
    chat: [
      u("go through last month's expenses and find anything unusual"),
      e("I'm on it. I'm going through all 214 expenses from October now and will come back with anything that looks off."),
    ],
    expect: { card: false },
  },
  {
    name: "report with nothing to decide",
    category: "nothing",
    source: "written",
    chat: [
      u("how did the instagram posts do this week"),
      e("This week's three posts reached 4,200 people, up 18% from last week. The Tuesday reel did best with 2,900 views. Nothing needs fixing."),
    ],
    expect: { card: false },
  },
  {
    name: "could not do it, nothing to choose",
    category: "nothing",
    source: "written",
    chat: [
      u("download my bank statement for september"),
      e("I couldn't get the September statement: the bank's site is down for maintenance until 6 PM today. I'll try again this evening and send it to you."),
    ],
    expect: { card: false },
  },
  {
    name: "explained how, no offer",
    category: "nothing",
    source: "written",
    chat: [
      u("how do i add a new staff member here"),
      e("Open Settings, go to Team, and press Add member. Enter their email and they'll get an invite. They can start chatting with me as soon as they accept."),
    ],
    expect: { card: false },
  },
  {
    name: "says what it will do later",
    category: "nothing",
    source: "written",
    chat: [
      u("i want to see today's sales every evening"),
      e("Set up. I'll send you today's sales at 9 PM once the shop closes, and every evening after that."),
    ],
    expect: { card: false },
  },
  {
    name: "fixed a mistake",
    category: "nothing",
    source: "written",
    chat: [
      u("make the invoice for Mehta & Sons"),
      e("Invoice 231 for Mehta & Sons is ready, ₹62,000 plus 12% GST."),
      u("gst should be 18 not 12"),
      e("Fixed. Invoice 231 now shows 18% GST, for a total of ₹73,160."),
    ],
    expect: { card: false },
  },

  // ── decision: card ─────────────────────────────────────────────────────────────────────────────────────────────
  {
    name: "send the drafted email",
    category: "decision",
    source: "written",
    chat: [
      u("write to ravi@northwind.example that the delivery will be two days late"),
      e("Here's the email to Ravi:\n\n> Hi Ravi, the delivery planned for Thursday will now reach you on Saturday because of a delay at the port. Sorry for the trouble.\n\nShould I send it?"),
    ],
    expect: { card: true },
  },
  {
    name: "offer to remind on Friday",
    category: "decision",
    source: "written",
    chat: [
      u("did acme pay invoice 212"),
      e("Not yet. Invoice 212 for ₹18,500 was due on Monday and is still unpaid. I can send Acme a polite reminder on Friday if it's still open then."),
    ],
    expect: { card: true },
  },
  {
    name: "delete the duplicates",
    category: "decision",
    source: "written",
    chat: [
      u("check my customer list for duplicates"),
      e("I found 37 duplicate customers out of 1,240, mostly the same phone number entered twice. I haven't changed anything. Do you want me to merge them?"),
    ],
    expect: { card: true },
  },
  {
    name: "approve the quote",
    category: "decision",
    source: "written",
    chat: [
      u("get me a quote for 500 visiting cards"),
      e("PrintWell quoted ₹1,450 for 500 cards on 350 gsm matte, delivered in four days. That's the cheapest of the three I checked. Shall I place the order?"),
    ],
    expect: { card: true },
  },
  {
    name: "schedule the post",
    category: "decision",
    source: "written",
    chat: [
      u("make a post about our new winter menu"),
      e("The post is ready: a photo of the soup trio with the caption \"Winter is here, and so is our new menu.\" I'd publish it tomorrow at 9 AM when your followers are most active. Okay to schedule it?"),
    ],
    expect: { card: true },
  },
  {
    name: "offer to make it weekly",
    category: "decision",
    source: "written",
    chat: [
      u("give me a summary of unpaid invoices"),
      e("You have 6 unpaid invoices worth ₹2,14,000. The oldest is Sharma Traders, 41 days overdue. I can send you this summary every Monday morning if that helps."),
    ],
    expect: { card: true },
  },
  {
    name: "reply to the customer complaint",
    category: "decision",
    source: "written",
    chat: [
      u("a customer left a bad review about slow service, what do we say"),
      e("I'd reply like this:\n\n> We're sorry about the wait on Saturday. We were short-staffed and it showed. Your next coffee is on us.\n\nWant me to post this reply on the review?"),
    ],
    expect: { card: true },
  },
  {
    name: "long chat ending in a go-ahead",
    category: "decision",
    source: "written",
    chat: [
      u("we need a new supplier for packaging boxes"),
      e("I'll look for packaging suppliers near Pune. What size boxes and how many a month?"),
      u("10x8x4 inch, about 2000 a month"),
      e("Got it. I'll compare prices for 2,000 boxes a month in that size."),
      u("ok"),
      e("I compared four suppliers. BoxKart is cheapest at ₹11.20 a box with free delivery; PackRight is ₹12 but delivers in two days instead of five. I'd go with BoxKart. Should I ask them for a sample batch of 50?"),
    ],
    expect: { card: true },
  },
  {
    name: "hindi chat",
    category: "decision",
    source: "written",
    chat: [
      u("शर्मा जी को कल की मीटिंग का रिमाइंडर भेजना है"),
      e("रिमाइंडर तैयार है:\n\n> नमस्ते शर्मा जी, कल सुबह 11 बजे हमारी मीटिंग है। कृपया समय पर आएं।\n\nक्या मैं इसे अभी व्हाट्सऐप पर भेज दूं?"),
    ],
    expect: { card: true, devanagari: true },
  },
  {
    name: "book the room",
    category: "decision",
    source: "written",
    chat: [
      u("what meetings do i have tomorrow"),
      e("You have two tomorrow: the supplier call at 11 AM and the staff review at 4 PM. The 4 PM one has no room booked. Do you want me to book the conference room for it?"),
    ],
    expect: { card: true },
  },
  {
    name: "plain offer",
    category: "decision",
    source: "written",
    chat: [
      u("summarise the lease agreement i uploaded"),
      e("The lease runs 3 years from January at ₹85,000 a month, rising 5% each year, with a 3-month notice period and a ₹2,55,000 deposit. Want me to turn this into a one-page PDF you can share with your partner?"),
    ],
    expect: { card: true },
  },
  {
    name: "something that can't be undone",
    category: "decision",
    source: "written",
    chat: [
      u("clear out the old test orders from the sheet"),
      e("I found 214 test orders from before April. Removing them can't be undone, so I haven't touched anything yet. Go ahead and delete them?"),
    ],
    expect: { card: true },
  },
  {
    name: "hinglish chat",
    category: "decision",
    source: "written",
    chat: [
      u("gupta ji ko payment ka reminder bhejna hai"),
      e("Reminder ready hai: \"Namaste Gupta ji, invoice 87 ka ₹32,000 abhi pending hai. Kripya is hafte payment kar dein.\" Abhi WhatsApp par bhej du?"),
    ],
    expect: { card: true },
  },

  // ── options: card with the named choices ───────────────────────────────────────────────────────────────────────
  {
    name: "daily or weekly",
    category: "options",
    source: "written",
    chat: [
      u("send me sales numbers regularly"),
      e("I can do that from your billing app. Would you like the sales numbers daily or weekly?"),
    ],
    expect: { card: true, offers: ["daily", "weekly"] },
  },
  {
    name: "pdf or excel",
    category: "options",
    source: "written",
    chat: [u("export the october attendance"), e("October attendance for all 18 staff is ready. Do you want it as a PDF or an Excel sheet?")],
    expect: { card: true, offers: ["pdf", "excel"] },
  },
  {
    name: "which of two named repos",
    category: "options",
    source: "written",
    chat: [
      u("tell me when someone stars our github"),
      e("I can watch for new stars and message you. You have two repos connected, emplio and docs. Which one should I watch?"),
    ],
    expect: { card: true, offers: ["emplio", "docs"] },
  },
  {
    name: "who gets the task",
    category: "options",
    source: "written",
    chat: [
      u("someone needs to call the landlord about the leak"),
      e("I'll make that a task. Both Rahul and Priya are free this afternoon. Who should I give it to?"),
    ],
    expect: { card: true, offers: ["rahul", "priya"] },
  },
  {
    name: "three named sizes",
    category: "options",
    source: "written",
    chat: [
      u("order a banner for the shop opening"),
      e("The printer has three sizes ready to go: small (3x2 ft), medium (6x3 ft) and large (10x4 ft). Which size should I order?"),
    ],
    expect: { card: true, offers: ["small", "medium", "large"] },
  },
];

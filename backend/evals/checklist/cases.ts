// Jobs of several parts, from brief to report, in a made-up business: each part takes a few commands, so a job
// that ticks only at the end leaves the person's list empty for most of the work.
import type { World } from "../emplio";

export type Case = { name: string; agent: string; brief: string; world: World };

const role = (name: string, what: string) => `## You are the ${name} agent\n${what}\n\n(no instructions of its own: do the task the brief gives)\n\n## ${name}'s tools\nNone yet.`;
const quote = (who: string, price: number, days: number) => `From: ${who}\nSubject: Quote for 500 m cotton twill\n\nPrice ₹${price}/m, delivery in ${days} days, 30 days credit.`;

export const cases: Case[] = [
  {
    name: "four supplier quotes into a sheet, cheapest to Sarah",
    agent: role("Supplier Finder", "Finds and compares suppliers for the shop's fabric"),
    brief:
      "Four suppliers sent quotes for 500 m cotton twill this week: Kestrel Textiles, Harbor Fabrics, Pine Mills and Atlas Weaves. Find each quote in Gmail, put supplier, price per metre and delivery days into /work/out/twill-quotes.csv, then email Sarah (sarah@kaveri.example) which is cheapest and why. Done when the sheet has all four and Sarah's mail is sent.",
    world: [
      ["gmail\\.search.*(Kestrel|kestrel)", '[{"id": "m1", "from": "sales@kestrel.example", "subject": "Quote for 500 m cotton twill"}]'],
      ["gmail\\.search.*(Harbor|harbor)", '[{"id": "m2", "from": "quotes@harbor.example", "subject": "Quote for 500 m cotton twill"}]'],
      ["gmail\\.search.*(Pine|pine)", '[{"id": "m3", "from": "orders@pinemills.example", "subject": "Quote for 500 m cotton twill"}]'],
      ["gmail\\.search.*(Atlas|atlas)", '[{"id": "m4", "from": "hello@atlasweaves.example", "subject": "Quote for 500 m cotton twill"}]'],
      ["gmail\\.search", '[{"id": "m1", "from": "sales@kestrel.example"}, {"id": "m2", "from": "quotes@harbor.example"}, {"id": "m3", "from": "orders@pinemills.example"}, {"id": "m4", "from": "hello@atlasweaves.example"}]'],
      ["get_message.*m1", quote("sales@kestrel.example", 182, 10)],
      ["get_message.*m2", quote("quotes@harbor.example", 175, 14)],
      ["get_message.*m3", quote("orders@pinemills.example", 168, 21)],
      ["get_message.*m4", quote("hello@atlasweaves.example", 179, 7)],
      ["in:sent", '[{"id": "s9", "to": "sent ok", "subject": "as sent"}]'],
      ["send_email", '{"id": "s9", "status": "sent"}'],
      ["twill-quotes\\.csv", "supplier,price_per_m,delivery_days\nKestrel Textiles,182,10\nHarbor Fabrics,175,14\nPine Mills,168,21\nAtlas Weaves,179,7"],
    ],
  },
  {
    name: "three overdue invoices: check payments, remind the unpaid",
    agent: role("Invoice Chaser", "Chases the shop's unpaid invoices by email"),
    brief:
      "Three invoices are overdue in Zoho Books: INV-2041 (Bluefin Cafe), INV-2047 (Corner Bakery) and INV-2052 (Maple Hotel). For each, check the bank transactions since 1 Nov for a matching payment. Note which are paid; send a polite reminder email to each one still unpaid. Done when every invoice is either matched to a payment or reminded.",
    world: [
      ["list_invoices|get_invoice", '[{"invoice": "INV-2041", "customer": "Bluefin Cafe", "amount": 18400, "email": "accounts@bluefin.example", "status": "overdue"}, {"invoice": "INV-2047", "customer": "Corner Bakery", "amount": 9250, "email": "owner@cornerbakery.example", "status": "overdue"}, {"invoice": "INV-2052", "customer": "Maple Hotel", "amount": 46100, "email": "finance@maplehotel.example", "status": "overdue"}]'],
      ["list_bank_transactions", '[{"date": "2026-11-03", "amount": 18400, "description": "NEFT BLUEFIN CAFE INV2041"}, {"date": "2026-11-06", "amount": 5000, "description": "UPI CORNER BAKE"}]'],
      ["in:sent", '[{"id": "s9", "to": "sent ok", "subject": "as sent"}]'],
      ["send_email", '{"id": "s3", "status": "sent"}'],
    ],
  },
  {
    name: "weekly report from three sources",
    agent: role("Report Maker", "Writes the shop's weekly reports"),
    brief:
      "Make this week's sales note: total this week's invoices from Zoho Books, count new leads in Gmail (subject has 'enquiry'), and list the three biggest customers this week. Write it to /work/out/week-note.md with a section each, then email it to Sarah (sarah@kaveri.example). Done when the note has all three sections and it's sent.",
    world: [
      ["list_invoices", '[{"invoice": "INV-2060", "customer": "Maple Hotel", "amount": 52000}, {"invoice": "INV-2061", "customer": "Bluefin Cafe", "amount": 12500}, {"invoice": "INV-2062", "customer": "Harbor Deli", "amount": 30900}, {"invoice": "INV-2063", "customer": "Corner Bakery", "amount": 8100}]'],
      ["gmail\\.search", '[{"id": "e1", "subject": "Enquiry: bulk napkins"}, {"id": "e2", "subject": "Enquiry about table linen"}, {"id": "e3", "subject": "Re: enquiry for hotel sheets"}]'],
      ["in:sent", '[{"id": "s9", "to": "sent ok", "subject": "as sent"}]'],
      ["send_email", '{"id": "s4", "status": "sent"}'],
      ["week-48-note\\.md", "# Week 48\n## Sales\n## Leads\n## Top customers"],
    ],
  },
];

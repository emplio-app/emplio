// PayU payments found by reading PayU's own transaction list, for owners who haven't pasted the webhook address
// into the PayU Dashboard (own/payu/triggers.ts): nothing to set up. One call per check over yesterday and today
// in Indian time; each payment fires once per status it reaches.
import { z } from "zod";
import type { PollTrigger } from "./index";

const IST_MS = 5.5 * 3_600_000;
const istDay = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);

// PayU wraps the rows as {status, msg, Transaction_details: [...]}; the rows are the one array in there
const rows = (out: unknown): Record<string, any>[] => {
  if (Array.isArray(out)) return out;
  return (Object.values((out ?? {}) as Record<string, unknown>).find(Array.isArray) as Record<string, any>[]) ?? [];
};

const SUCCESS = ["captured", "success", "auth"];
const FAILED = ["failed", "failure", "bounced", "dropped", "usercancelled"];

const new_payment: PollTrigger = {
  description:
    "A payment shows up in PayU's transaction list: successful ones by default, or failed or all. Works with no setup; checked every few minutes, so it can lag a little behind the instant payment_successful trigger.",
  config: z.object({
    status: z.enum(["success", "failed", "all"]).optional().describe("success (default): paid; failed: failed, bounced or abandoned; all: every attempt"),
    min_amount: z.number().min(0).optional().describe("Only payments of at least this many rupees"),
  }),
  output: [
    { name: "id", type: "string", required: true, description: "PayU's payment id (mihpayid)" },
    { name: "txnid", type: "string", required: true, description: "The business's own order id" },
    { name: "status", type: "string", required: true, description: "captured (paid), failed, bounced, dropped, userCancelled, refunded…" },
    { name: "amount", type: "string", required: true, description: "Amount in rupees" },
    { name: "mode", type: "string", required: false, description: "How they paid: UPI, CC, DC, NB…" },
    { name: "productinfo", type: "string", required: false, description: "What it was for" },
    { name: "firstname", type: "string", required: false, description: "Customer's name" },
    { name: "email", type: "string", required: false, description: "Customer's email" },
    { name: "addedon", type: "string", required: false, description: "When, Indian time" },
  ],
  every: 5,
  min: 2,
  async poll(config: { status?: string; min_amount?: number }, run) {
    const out = await run("payu.list_transactions", { from: istDay(Date.now() - 86_400_000), to: istDay(Date.now()) });
    const want = config.status ?? "success";
    return rows(out)
      .filter((r) => {
        const s = String(r.status ?? r.unmappedstatus ?? "").toLowerCase();
        if (want === "success" && !SUCCESS.includes(s)) return false;
        if (want === "failed" && !FAILED.includes(s)) return false;
        return config.min_amount === undefined || Number(r.amount) >= config.min_amount;
      })
      .map((r) => ({ id: `${r.id ?? r.mihpayid}:${r.status}`, item: r }));
  },
};

export const payu: Record<string, PollTrigger> = { new_payment };

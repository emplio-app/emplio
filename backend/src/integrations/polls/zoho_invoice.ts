import { accountingPolls } from "./zoho_books";

// the same triggers as Zoho Books; Invoice has only customers, so no contact_type to filter on
export const zoho_invoice = accountingPolls("zoho_invoice", { payments: "list_payments" }, {});

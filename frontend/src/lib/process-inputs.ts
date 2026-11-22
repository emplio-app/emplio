import type { RunInput } from "@emplio/shared";

type Go = { subject: string; clientId: string | null; inputs: RunInput[] };

// A value filled in, as people read it: 85,000 · 1 Dec 2026 · the rest as typed.
export function inputText(x: Pick<RunInput, "type" | "value">) {
  if (!x.value) return "";
  if (x.type === "number") return Number(x.value).toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (x.type === "date") return new Date(`${x.value}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return x.value;
}

// whether a go's first input is already in its name
const named = (r: Go) => !!r.inputs[0]?.value && (!!r.clientId || r.inputs[0].value === r.subject);

// What a go is called: its first input then its client (INV-1042 · Northwind), else what it's for.
export const runName = (r: Go) => (named(r) && r.clientId ? `${inputText(r.inputs[0]!)} · ${r.subject}` : r.subject);

// The rest of what was filled in, for under its name: "Amount 85,000 · Due date 1 Dec 2026"
export const runDetails = (r: Go) =>
  r.inputs
    .filter((x, i) => x.value && !(i === 0 && named(r)))
    .map((x) => `${x.name} ${inputText(x)}`)
    .join(" · ");

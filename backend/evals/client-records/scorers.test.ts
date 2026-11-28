import { expect, test } from "bun:test";
import { cases } from "./cases";
import { amount, rightCall, rightDetails, writesOf } from "./scorers";

const said = (commands: string[], text = "Done.") => ({ text, last: text, commands });
const kinds = (c: string[]) => writesOf(c).map((w) => w.kind);

test("each write is read off its command", () => {
  expect(kinds([`emplio meetings add "Northwind call" --client northwind --people "Sarah Lee, Priya"`])).toEqual(["meeting"]);
  expect(kinds(["cat > /work/company/meetings/2026-11-10-northwind-call.md <<'EOF'\n# x\nEOF"])).toEqual(["meeting-notes"]);
  expect(kinds(["cat >> /work/company/clients/northwind-traders/index.md <<'EOF'\nx\nEOF"])).toEqual(["notes"]);
  expect(kinds(["cat > /work/company/knowledge/pricing.md <<'EOF'\nx\nEOF"])).toEqual(["knowledge"]);
  expect(kinds(["cat /work/company/meetings/2026-11-03-northwind-website-kickoff.md"])).toEqual([]);
  expect(kinds(["emplio clients update adatum --private yes"])).toEqual(["private"]);
  expect(kinds(["emplio projects update northwind-website --lead raj", "emplio contacts add 'Daniel Kim' --client northwind"])).toEqual(["project-change", "contact"]);
  expect(kinds(["emplio clients show northwind; emplio meetings list --client northwind", "emplio search sarah"])).toEqual([]);
});

test("amounts are read as people write them", () => {
  expect(amount("3.5L")).toBe("350000");
  expect(amount("45k")).toBe("45000");
  expect(amount("₹60,000")).toBe("60000");
  expect(amount("75000")).toBe("75000");
});

test("the right records, and the details they carry", () => {
  const ok = said([`emplio meetings add "Call" --client "Northwind Traders" --people "Sarah Lee"`, "cat > /work/company/meetings/2026-11-10-call.md <<'EOF'\nx\nEOF"]);
  const want = { kinds: ["meeting", "meeting-notes"] as const, has: { meeting: { client: "northwind", people: ["sarah"] } } };
  expect(rightCall({ output: ok, expected: { ...want, kinds: [...want.kinds] } }).score).toBe(1);
  expect(rightDetails({ output: ok, expected: { ...want, kinds: [...want.kinds] } }).score).toBe(1);
  const loose = said(["cat > /work/company/knowledge/northwind-call.md <<'EOF'\nx\nEOF"]);
  expect(rightCall({ output: loose, expected: { kinds: ["meeting", "meeting-notes"] } }).score).toBe(0);
  const noPeople = said([`emplio meetings add "Call" --client northwind`]);
  expect(rightDetails({ output: noPeople, expected: { kinds: ["meeting"], has: { meeting: { people: ["sarah"] } } } }).score).toBe(0);
  expect(rightDetails({ output: said(["emplio services add 'Google Ads' --amount 35k --period monthly"]), expected: { kinds: ["service"], has: { service: { name: "ads", amount: "35000", period: "monthly" } } } }).score).toBe(1);
});

test("the cases are well formed", async () => {
  const all = await cases();
  expect(new Set(all.map((c) => c.name)).size).toBe(all.length);
  for (const c of all) for (const k of Object.keys(c.expect.has ?? {})) expect([...c.expect.kinds, ...(c.expect.allow ?? [])]).toContain(k as never);
});

test("a read that hides its errors writes nothing", () => {
  expect(writesOf(["cat /work/company/meetings/a.md 2>/dev/null || cat /work/company/meetings/b.md"])).toEqual([]);
});

import { expect, test } from "bun:test";
import { cases } from "./cases";
import { rightCall, rightClient, rightFile, rightInputs, rightPerson, words, writesOf } from "./scorers";

const said = (commands: string[], text = "Done.") => ({ text, last: text, commands });
const args = (commands: string[], expected: Parameters<typeof rightCall>[0]["expected"], text?: string) => ({ output: said(commands, text), expected });

test("a command line is read as a shell reads it", () => {
  expect(words(`emplio clients update northwind 'Contact email=tom@northwind.example' --stage active`).words).toEqual(["emplio", "clients", "update", "northwind", "Contact email=tom@northwind.example", "--stage", "active"]);
  expect(words(`emplio processes add closure - <<'EOF'\n---\ntitle: X\n---\nEOF`)).toEqual({ words: ["emplio", "processes", "add", "closure", "-"], body: "---\ntitle: X\n---" });
  expect(words(`emplio tasks add "Send Sarah's letter" --to raj`).words).toEqual(["emplio", "tasks", "add", "Send Sarah's letter", "--to", "raj"]);
});

test("each write is read off its command", () => {
  const kinds = (c: string[]) => writesOf(c).map((w) => w.kind);
  expect(kinds(["emplio tasks add 'Call Contoso' --to me --client contoso"])).toEqual(["task"]);
  expect(kinds(["emplio tasks add 'Check bank feeds' --every '0 9 * * 1' --to raj"])).toEqual(["repeat"]);
  expect(kinds(["emplio automations add onboard - <<'EOF'\n---\nwhen: new client\nprocess: client-onboarding\n---\nX\nEOF"])).toEqual(["new-client"]);
  expect(kinds(["emplio clients update northwind 'Files=quarterly'"])).toEqual(["detail"]);
  expect(kinds(["emplio clients update northwind --handler priya"])).toEqual(["client"]);
  expect(kinds(["cat > /work/company/contacts/anna.md <<'EOF'\n---\nclient: [[clients/fabrikam]]\n---\nEOF"])).toEqual(["contact"]);
  expect(kinds(["emplio clients list; emplio processes runs --client northwind"])).toEqual([]);
  expect(kinds(["cat > /work/company/processes/closure.md <<'EOF'\n---\ntitle: X\n---\nEOF"])).toEqual(["write-process"]);
});

test("the right door, and no other that writes", () => {
  expect(rightCall(args(["emplio tasks add 'Send letter' --to raj --client northwind"], { kinds: ["task"] })).score).toBe(1);
  expect(rightCall(args(["emplio tasks add 'Remind' --to raj --client fabrikam", "emplio tasks add 'Call' --to raj --client fabrikam"], { kinds: ["process"] })).score).toBe(0);
  expect(rightCall(args(["emplio processes start payment-chase --client contoso --invoice X"], { kinds: ["ask"] })).score).toBe(0);
  expect(rightCall(args(["emplio processes show payment-chase"], { kinds: ["ask"] }, "What's the invoice number and amount?")).score).toBe(1);
  expect(rightCall(args(["emplio clients list"], { kinds: [] })).score).toBe(1);
  expect(rightCall(args(["emplio automations add books - <<'EOF'\n---\nwhen: schedule\n---\nX\nEOF"], { kinds: [] })).score).toBe(0);
});

test("client, person and inputs are marked only when they apply", () => {
  expect(rightClient(args(["emplio tasks add X --client 'Northwind Traders'"], { kinds: ["task"], client: "northwind" })).score).toBe(1);
  expect(rightClient(args(["emplio tasks add X"], { kinds: ["task"], client: "northwind" })).score).toBe(0);
  expect(rightClient(args(["emplio clients list"], { kinds: ["task"], client: "northwind" })).score).toBeNull();
  expect(rightPerson(args(["emplio tasks add X --to raj@kaveri.example"], { kinds: ["task"], to: "raj" })).score).toBe(1);
  expect(rightPerson(args(["emplio tasks add X --to me"], { kinds: ["task"], to: "meera" })).score).toBe(1);
  expect(rightPerson(args(["emplio tasks add X --to priya"], { kinds: ["task"], to: "raj" })).score).toBe(0);
  const start = "emplio processes start payment-chase --client fabrikam --invoice INV-2231 --amount 64,500 --due-date 2026-11-01";
  expect(rightInputs(args([start], { kinds: ["process"], process: "payment-chase", inputs: { invoice: "INV-2231", amount: "64500", "due-date": "2026-11-01" } })).score).toBe(1);
  expect(rightInputs(args([`${start} --note guessed`], { kinds: ["process"], process: "payment-chase", inputs: { invoice: "INV-2231", amount: "64500", "due-date": "2026-11-01" } })).score).toBe(0);
});

test("files are read with the app's own readers", async () => {
  const auto = (body: string) => [`emplio automations add x - <<'EOF'\n${body}\nEOF`];
  expect((await rightFile(args(auto("---\nwhen: new client\nprocess: client-onboarding\n---\nOnboard"), { kinds: ["new-client"], file: { when: "new client", process: "client-onboarding" } }))).score).toBe(1);
  expect((await rightFile(args(auto("---\nwhen: schedule\nschedule: \"0 9 1 4 *\"\nprocess: annual-filing\n---\nX"), { kinds: ["repeat"], file: { process: "annual-filing" } }))).score).toBe(0);
  expect((await rightFile(args(["emplio processes add x - <<'EOF'\n---\ntitle: X\nevery: \"0 9 1 * *\"\nsteps: [A]\n---\nEOF"], { kinds: ["write-process"] }))).score).toBe(0);
  expect((await rightFile(args(["emplio tasks add 'Bank feeds' --every '0 9 * * 1' --to raj"], { kinds: ["repeat"], file: { who: "raj" } }))).score).toBe(1);
  expect((await rightFile(args(["emplio clients list"], { kinds: [] }))).score).toBeNull();
});

test("every case has its own name and ends where Emplio answers next", async () => {
  const all = await cases();
  expect(new Set(all.map((c) => c.name)).size).toBe(all.length);
  for (const c of all) expect(c.chat.at(-1)?.role).toBe("user");
  for (const cat of new Set(all.map((c) => c.category))) expect(all.filter((c) => c.category === cat).length).toBeGreaterThan(0);
});

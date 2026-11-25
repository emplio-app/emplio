import { expect, test } from "bun:test";
import { cases } from "./cases";
import { actsOf, rightCall, rightValues, saysWhy } from "./scorers";

const args = (commands: string[], expected: Parameters<typeof rightCall>[0]["expected"]) => ({ output: { text: "", commands }, expected });

test("acts are read off the commands", () => {
  expect(actsOf(["emplio processes set 7c1e04aa --amount 55000"]).map((a) => `${a.act} ${a.id}`)).toEqual(["set 7c1e04aa"]);
  expect(actsOf(["emplio tasks update f1a2b3c4 --status waiting --waiting 'Meera: the receipt'"]).map((a) => a.act)).toEqual(["waiting"]);
  expect(actsOf(["emplio tasks done c05d8e11"]).map((a) => a.act)).toEqual(["done"]);
  expect(actsOf(["emplio processes runs", "emplio tasks list --client contoso"])).toEqual([]);
});

test("the right act on the right run, and nothing else that writes", () => {
  expect(rightCall(args(["emplio processes set 7c1e04aa --amount 55000"], { acts: [{ act: "set", id: "7c1e04aa" }] })).score).toBe(1);
  expect(rightCall(args(["emplio processes set 3b9f2d10 --amount 55000"], { acts: [{ act: "set", id: "7c1e04aa" }] })).score).toBe(0);
  expect(rightCall(args(["emplio processes start payment-chase --client fabrikam"], { acts: [{ act: "set", id: "7c1e04aa" }] })).score).toBe(0);
  expect(rightCall(args(["emplio processes stop 51d0c9e3", "emplio clients update wingtip --stage past"], { acts: [{ act: "stop", id: "51d0c9e3" }], allow: ["client"] })).score).toBe(1);
  expect(rightCall(args([], { acts: [] })).score).toBe(1);
});

test("values and the reason for sending back", () => {
  expect(rightValues(args(["emplio processes set 7c1e04aa --amount 55,000"], { acts: [{ act: "set", id: "7c1e04aa", inputs: { amount: "55000" } }] })).score).toBe(1);
  expect(rightValues(args(["emplio processes set 7c1e04aa --amount 85000"], { acts: [{ act: "set", id: "7c1e04aa", inputs: { amount: "55000" } }] })).score).toBe(0);
  expect(rightValues(args([], { acts: [{ act: "set", id: "7c1e04aa", inputs: { amount: "55000" } }] })).score).toBeNull();
  expect(saysWhy(args(["emplio processes back e4a77c02 --note 'AGM is on 18 Dec, fix the date'"], { acts: [] })).score).toBe(1);
  expect(saysWhy(args(["emplio processes back e4a77c02"], { acts: [] })).score).toBe(0);
});

test("every case has its own name and ends where Emplio answers next", async () => {
  const all = await cases();
  expect(new Set(all.map((c) => c.name)).size).toBe(all.length);
  for (const c of all) expect(c.chat.at(-1)?.role).toBe("user");
});

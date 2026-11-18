import { expect, test } from "bun:test";
import { agentMd, described, flags, parseAgent, skillsUsed, slugOf, toolsIn, toolsUsed } from "./agents";

test("AGENT.md round-trips", () => {
  const a = { name: "Supplier Finder", description: "Finds suppliers. Use for: cheaper vendor", skills: ["web-research", "price-compare"], tools: ["gmail.send", "suppliers.find_near"], level: "strong" as const, archived: false, instructions: "Near first, then wider." };
  expect(parseAgent("supplier-finder", agentMd(a))).toEqual({ slug: "supplier-finder", ...a });
  expect(parseAgent("x", agentMd({ ...a, archived: true })).archived).toBe(true);
  // hand-written, quoted, no level: light
  expect(parseAgent("x", `---\nname: "X"\nskills: ["a", b]\n---\nDo it.`)).toMatchObject({ name: "X", skills: ["a", "b"], tools: [], level: "light", instructions: "Do it." });
  // no tools: AGENT.md stays as it was before agents had tools
  expect(agentMd({ ...a, tools: [] })).not.toContain("tools:");
  expect(parseAgent("x", `---\nname: X\ntools: [gmail.send, not a tool, b.c]\n---\n`).tools).toEqual(["gmail.send", "b.c"]);
});

test("slugs and flags", () => {
  expect(slugOf("Supplier Finder!")).toBe("supplier-finder");
  expect(slugOf("agents/supplier-finder")).toBe("supplier-finder");
  expect(flags(["find", "--agent", "Supplier Finder", "brief", "--level", "strong"], ["agent", "level"])).toEqual({ set: { agent: "Supplier Finder", level: "strong" }, rest: ["find", "brief"] });
});

test("a toolset file's tools: labelled functions, with what they take and do", () => {
  const py = `"""Gmail tools."""
import emplio


def _headers(account):
    return {}


# risk: reads
def search(q, account, limit=10):
    """Find mails, at most limit."""
    return []


# risk: changes
@retry
async def send(
    to,
    body: str,
    account="office",
) -> dict:
    \'\'\'Send a mail.

    More words.\'\'\'
    return {}


def helper(x):
    """Not a tool: no label."""


# risk: spends
def buy(n):
    return n
`;
  expect(toolsIn("gmail", py)).toEqual([
    { name: "gmail.search", signature: "search(q, account, limit=10)", description: "Find mails, at most limit.", risk: "only reads" },
    { name: "gmail.send", signature: "send(to, body: str, account=\"office\")", description: "Send a mail. Returns dict.", risk: "changes things" },
    { name: "gmail.buy", signature: "buy(n)", description: "(no description)", risk: "spends money" },
  ]);
});

test("a tool's line says what it gives back: its docstring's sentence about it, else its annotation", () => {
  expect(described("Messages in a thread.\n\n    Each one a dict. Returns a list of dicts with from, text.", "list")).toBe("Messages in a thread. Returns a list of dicts with from, text.");
  expect(described("Returns the sheet's rows as lists.")).toBe("Returns the sheet's rows as lists.");
  expect(described("Archive a thread.")).toBe("Archive a thread.");
});

test("the tools a piece of work saved or used", () => {
  const parts = [
    { input: { code: "emplio.tools.save(grant_pro, area='billing', risk='changes')" }, output: { output: "Saved tool billing.grant_pro (changes things) in company/toolset/billing.py." } },
    { input: { code: "from tools.gmail import send, search as find\nfrom tools.billing import (\n  plan,\n)\nemplio.tools.reddit.post(x)" } },
    { input: { code: "from tools import nothing\nprint('Saved tool not.this (')" }, output: { output: "Saved tool  x" } },
  ];
  expect(toolsUsed(parts).sort()).toEqual(["billing.grant_pro", "billing.plan", "gmail.search", "gmail.send", "reddit.post"]);
});

test("the skills a run read or wrote", () => {
  const parts = [
    { input: { code: 'print(emplio.skills.use("website-login")[:3000])' } },
    { input: { command: "emplio skills use courier-booking" } },
    { input: { code: 'Path("/work/company/skillset/returns/SKILL.md").write_text(text)' } },
    { input: { code: 'print(open("/work/company/skillset/other/SKILL.md").read())' } },
  ];
  expect(skillsUsed(parts).sort()).toEqual(["courier-booking", "returns", "website-login"]);
});

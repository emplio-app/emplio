import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as gitea from "./gitea";
import * as time from "./time";
import { agentsCommand, findAgent, listAgents } from "./agents";
import { toolsetTidy } from "./heartbeat";

// other files spy on these at their top level (mentions.test.ts), which lasts the whole run
beforeEach(() => mock.restore());
afterEach(() => mock.restore());

// an in-memory Gitea: repo -> path -> text
function fake(files: Record<string, Record<string, string>>) {
  spyOn(gitea, "readFile").mockImplementation(async (_w, repo, path) => files[repo]?.[path] ?? null);
  spyOn(gitea, "listPaths").mockImplementation(async (_w, repo) => Object.keys(files[repo] ?? {}).map((path) => ({ path, sha: `${repo}:${path}:${files[repo]![path]!.length}`, size: 1 })));
  spyOn(gitea, "writeFile").mockImplementation(async (_w, repo, path, content) => {
    files[repo] ??= {};
    if (content === null) delete files[repo]![path];
    else files[repo]![path] = content;
    return true;
  });
  spyOn(time, "timezoneOf").mockResolvedValue("UTC");
  return files;
}
const md = (name: string) => `---\nname: ${name}\ndescription: d\nskills: []\nlevel: light\n---\nDo it.\n`;
const author = { name: "A", email: "a@x.y" };

test("agents live in a bucket: members see company and their own, admins restricted too", async () => {
  fake({ company: { "agents/web/AGENT.md": md("Web") }, restricted: { "agents/payroll/AGENT.md": md("Payroll") }, "me-u1": { "agents/mine/AGENT.md": md("Mine") } });
  expect((await listAgents("w")).map((a) => a.slug)).toEqual(["web"]);
  expect((await listAgents("w", { userId: "u1" })).map((a) => a.slug).sort()).toEqual(["mine", "web"]);
  expect((await listAgents("w", { userId: "u2", admin: true })).map((a) => a.slug).sort()).toEqual(["payroll", "web"]);
  expect(await findAgent("w", "payroll", { userId: "u1" })).toBeNull();
  expect((await findAgent("w", "payroll", { userId: "u1", admin: true }))?.repo).toBe("restricted");
});

test("add --bucket writes to that bucket's repo; lessons follow the agent", async () => {
  const files = fake({});
  const member = { workspaceId: "w", userId: "u1", admin: false, job: false, author };
  expect((await agentsCommand(member, ["add", "Payroll", "--description", "pay", "--bucket", "restricted"])).text).toContain("only an owner or admin");
  expect((await agentsCommand(member, ["add", "My Helper", "--description", "mine", "--bucket", "me"])).text).toContain("added me/agents/my-helper");
  expect(files["me-u1"]!["agents/my-helper/AGENT.md"]).toContain("name: My Helper");
  await agentsCommand(member, ["learn", "my-helper", "the export button moved"]);
  expect(files["me-u1"]!["agents/my-helper/LESSONS.md"]).toContain("the export button moved");
  expect((await agentsCommand({ ...member, userId: "u2" }, ["show", "my-helper"])).text).toContain("no agent");
  expect((await agentsCommand(member, ["add", "X", "--description", "x", "--bucket", "nope"])).text).toContain("--bucket is");
});

test("the daily cleanup is told about look-alike tools, long files and old functions.py", async () => {
  const tool = (name: string, doc: string) => `# risk: reads\ndef ${name}(x):\n    """${doc}"""\n    return x\n`;
  fake({
    company: {
      "toolset/gmail.py": tool("send", "Send an email."),
      "toolset/mail.py": tool("send", "Send a mail."),
      "toolset/big.py": "x = 1\n".repeat(320),
      "skills/invoices/functions.py": "def total(): pass\n",
    },
    restricted: { "toolset/pay.py": tool("payslip", "Make a payslip.") + tool("slip", "make a PAYSLIP.") },
  });
  const tidy = await toolsetTidy("w");
  expect(tidy).toContain("gmail.send (company/toolset/gmail.py) and mail.send");
  expect(tidy).toContain("pay.payslip (restricted/toolset/pay.py) and pay.slip");
  expect(tidy).toContain("company/toolset/big.py: 321 lines");
  expect(tidy).toContain("company/skills/invoices/functions.py: move its functions into tools");
});

test("a tool that changes things: Just do it runs it now, a live step just hears allowed, a background run is refused", async () => {
  const { toolsCommand } = await import("./sandbox");
  const ran: string[] = [];
  const box = { run: async (cmd: string) => (ran.push(cmd), { exitCode: 0, result: "granted" }) } as never;
  const s = (more: object) => ({ workspaceId: "w", conversationId: "c", user: { id: "u", name: "Asha" }, settings: { approvals: "auto" }, ...more }) as never;
  const args = ["allow", "billing.grant_pro", JSON.stringify({ args: ["a@b.c"], kwargs: { months: 2 }, risk: "changes" })];
  expect(await toolsCommand(box, s({}), args)).toBe("Allowed, and tools.billing.grant_pro ran:\ngranted");
  expect(ran[0]).toContain('EMPLIO_TOOL_OK"] = "billing.grant_pro"');
  expect(ran[0]).toContain("from tools.billing import grant_pro");
  expect(await toolsCommand(box, s({ live: true }), args)).toBe("allowed");
  spyOn(await import("./approvals"), "alwaysAllowed").mockResolvedValue([]);
  expect(await toolsCommand(box, s({ automation: { name: "x" }, settings: { approvals: "ask" } }), args)).toContain("a run nobody is watching");
  expect(await toolsCommand(box, s({}), ["allow", "not a name", "{}"])).toContain("usage:");
});

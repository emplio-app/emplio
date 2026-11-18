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

test("the daily cleanup is told about look-alike tools and long files", async () => {
  const tool = (name: string, doc: string) => `# risk: reads\ndef ${name}(x):\n    """${doc}"""\n    return x\n`;
  fake({
    company: {
      "toolset/gmail.py": tool("send", "Send an email."),
      "toolset/mail.py": tool("send", "Send a mail."),
      "toolset/big.py": "x = 1\n".repeat(320),
    },
    restricted: { "toolset/pay.py": tool("payslip", "Make a payslip.") + tool("slip", "make a PAYSLIP.") },
  });
  const tidy = await toolsetTidy("w");
  expect(tidy).toContain("gmail.send (company/toolset/gmail.py) and mail.send");
  expect(tidy).toContain("pay.payslip (restricted/toolset/pay.py) and pay.slip");
  expect(tidy).toContain("company/toolset/big.py: 321 lines");
});

test("a tool that changes things: Just do it runs it now, a live step just hears allowed", async () => {
  const { toolsCommand } = await import("./sandbox");
  const ran: string[] = [];
  const runner = async (cmd: string) => (ran.push(cmd), { exitCode: 0, output: "granted" });
  const s = (more: object) => ({ workspaceId: "w", conversationId: "c", user: { id: "u", name: "Asha" }, settings: { approvals: "auto" }, ...more }) as never;
  // a big id stays exact: the inputs reach the run as the text Python sent
  const args = ["allow", "billing.grant_pro", '{"args": ["a@b.c"], "kwargs": {"months": 2, "ref": 1234567890123456789}, "risk": "changes"}'];
  expect(await toolsCommand(s({}), args, runner)).toBe("Allowed, and tools.billing.grant_pro ran:\ngranted");
  expect(ran[0]).toContain('EMPLIO_TOOL_OK"] = "billing.grant_pro"');
  expect(ran[0]).toContain("from tools.billing import grant_pro");
  expect(ran[0]).toContain("1234567890123456789");
  expect(await toolsCommand(s({ live: true }), args, runner)).toBe("allowed");
  // ponytail: the background refusal is approve()'s own (approvals.test.ts); git-proxy.test.ts fakes approve for every file
  expect(await toolsCommand(s({}), ["allow", "not a name", "{}"], runner)).toContain("usage:");
});

test("a company agent's list takes only company tools and skills, never admins-only or someone's own", async () => {
  const { addTools } = await import("./agents");
  const tool = (name: string) => `# risk: reads\ndef ${name}(x):\n    """Does ${name}."""\n    return x\n`;
  const files = fake({
    company: { "agents/web/AGENT.md": md("Web"), "toolset/gmail.py": tool("send"), "skillset/quote/SKILL.md": "x" },
    restricted: { "toolset/payroll.py": tool("salaries"), "skillset/pay/SKILL.md": "x" },
    "me-u1": { "toolset/mine.py": tool("own") },
  });
  const web = (await findAgent("w", "web"))!;
  await addTools({ workspaceId: "w", author, admin: true }, web, ["gmail.send", "payroll.salaries", "mine.own", "gmail.nope"], ["quote", "pay"]);
  expect(files.company!["agents/web/AGENT.md"]).toContain("tools: [gmail.send]");
  expect(files.company!["agents/web/AGENT.md"]).toContain("skills: [quote]");
});

test("a member adding an agent named like an admins-only one hears only that the name is taken", async () => {
  fake({ restricted: { "agents/payroll/AGENT.md": md("Payroll") } });
  const member = { workspaceId: "w", userId: "u1", admin: false, job: false, author };
  expect((await agentsCommand(member, ["add", "Payroll", "--description", "x"])).text).toBe("error: the name Payroll is taken; pick another");
});

test("a team agent keeps its maker, and only they or an owner or admin change it", async () => {
  const files = fake({ company: { "agents/old/AGENT.md": md("Old") } });
  const maker = { workspaceId: "w", userId: "u1", admin: false, job: false, author };
  const other = { ...maker, userId: "u2" };
  await agentsCommand(maker, ["add", "Web Helper", "--description", "web"]);
  expect(files.company!["agents/web-helper/AGENT.md"]).toContain("created_by: u1");
  expect((await findAgent("w", "web-helper"))?.createdBy).toBe("u1");
  for (const sub of ["update", "archive", "remove"]) expect((await agentsCommand(other, [sub, "web-helper", "--level", "strong"])).text).toContain("only whoever made Web Helper");
  expect((await agentsCommand(other, ["learn", "web-helper", "the login moved"])).text).toContain("noted");
  expect((await agentsCommand(maker, ["update", "web-helper", "--level", "strong"])).text).toContain("updated");
  expect(files.company!["agents/web-helper/AGENT.md"]).toContain("created_by: u1");
  expect((await agentsCommand({ ...other, admin: true }, ["archive", "web-helper"])).text).toContain("archived");
  // made before makers were kept: owners and admins only
  expect((await agentsCommand(maker, ["archive", "old"])).text).toContain("made before Emplio kept track");
  expect((await agentsCommand({ ...maker, admin: true }, ["archive", "old"])).text).toContain("archived");
});

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The emplio Python library against a stand-in `emplio` command that prints what it was given.
const py = (code: string, env: Record<string, string> = {}) => {
  const home = mkdtempSync(join(tmpdir(), "pylib-"));
  writeFileSync(join(home, "emplio"), `#!/usr/bin/env python3\nimport json, sys\nprint(json.dumps({"args": sys.argv[1:], "stdin": sys.stdin.read()}))\n`, { mode: 0o755 });
  const p = Bun.spawnSync(["python3", "-c", `import emplio\n${code}`], {
    env: { PATH: `${home}:${process.env.PATH}`, PYTHONPATH: join(import.meta.dir, "python/py"), ...env },
  });
  return { out: p.stdout.toString(), err: p.stderr.toString(), home };
};

test("input= reaches commands that read it after a '-'", () => {
  const { out, err } = py(`print(emplio.automations.add("daily", input="---\\nwhen: manual\\n---\\nhi"))\nprint(emplio.db.sql(input="select 1"))\nprint(emplio.apps.run("gmail.send", input="{}"))`);
  expect(err).toBe("");
  const [auto, sql, app] = out.trim().split("\n").map((l) => JSON.parse(l.replace(/'/g, '"')));
  expect(auto.args).toEqual(["automations", "add", "daily", "-"]);
  expect(auto.stdin).toContain("when: manual");
  expect(sql.args).toEqual(["db", "sql", "-"]);
  expect(app.args).toEqual(["apps", "run", "gmail.send", "-"]);
});

test("a process's text goes in with input=, as the command line's '-'", () => {
  const { out, err } = py(`print(emplio.processes.add("onboarding", input="---\\ntitle: Onboarding\\n---"))\nprint(emplio.processes.start("onboarding", client="Northwind"))`);
  expect(err).toBe("");
  const [add, start] = out.trim().split("\n").map((l) => JSON.parse(l.replace(/'/g, '"')));
  expect(add.args).toEqual(["processes", "add", "onboarding", "-"]);
  expect(add.stdin).toContain("title: Onboarding");
  expect(start.args).toEqual(["processes", "start", "onboarding", "--client", "Northwind"]);
});

test("a process's inputs go in as flags, due_date= as --due-date, numbers as text", () => {
  const { out, err } = py(`print(emplio.processes.start("payment-chase", client="Northwind", invoice="INV-1042", amount=85000, due_date="2026-12-01"))\nprint(emplio.processes.set("ab12cd34", amount=60000))`);
  expect(err).toBe("");
  const [start, set] = out.trim().split("\n").map((l) => JSON.parse(l.replace(/'/g, '"')));
  expect(start.args).toEqual(["processes", "start", "payment-chase", "--client", "Northwind", "--invoice", "INV-1042", "--amount", "85000", "--due-date", "2026-12-01"]);
  expect(set.args).toEqual(["processes", "set", "ab12cd34", "--amount", "60000"]);
});

test("a tool saved with /work paths works where /work is a folder in the person's home", () => {
  const work = mkdtempSync(join(tmpdir(), "work-"));
  mkdirSync(join(work, "company/toolset"), { recursive: true });
  writeFileSync(join(work, "company/toolset/s.py"), `KEY = "/work/tmp/key.pem"\nOTHER = "/workspace/x"\n`);
  const { out, err } = py(`s = emplio.tools.s; print(s.KEY); print(s.OTHER)`, { EMPLIO_WORK: work });
  expect(err).toBe("");
  expect(out.trim().split("\n")).toEqual([`${work}/tmp/key.pem`, "/workspace/x"]);
});

test("a tool saved on a person's own computer keeps /work, not their folder", () => {
  const work = mkdtempSync(join(tmpdir(), "work-"));
  mkdirSync(join(work, "company/toolset"), { recursive: true });
  const file = join(work, "company/toolset/s.py");
  writeFileSync(file, `KEY = "${work}/restricted/key.pem"\n`);
  const p = Bun.spawnSync(["python3", "-c", "import sys, kernel; print(kernel.check_saved(sys.argv[1]))", file], {
    env: { PATH: process.env.PATH!, PYTHONPATH: join(import.meta.dir, "python"), EMPLIO_WORK: work },
  });
  expect(p.stderr.toString()).toBe("");
  expect(readFileSync(file, "utf8")).toBe(`KEY = "/work/restricted/key.pem"\n`);
});

test("an old-style functions.py written by a run gets a note to keep tools instead", () => {
  const work = mkdtempSync(join(tmpdir(), "work-"));
  mkdirSync(join(work, "company/skillset/s"), { recursive: true });
  const file = join(work, "company/skillset/s/functions.py");
  writeFileSync(file, "def f():\n    pass\n");
  const p = Bun.spawnSync(["python3", "-c", "import sys, kernel; print(kernel.check_saved(sys.argv[1]))", file], {
    env: { PATH: process.env.PATH!, PYTHONPATH: join(import.meta.dir, "python"), EMPLIO_WORK: work },
  });
  expect(p.stdout.toString()).toContain("emplio.tools.save(fn");
});

test("a tool that uses another tool passes the after-run check; emplio.skill says where tools are", () => {
  const work = mkdtempSync(join(tmpdir(), "work-"));
  mkdirSync(join(work, "company/toolset"), { recursive: true });
  writeFileSync(join(work, "company/toolset/gmail.py"), '# risk: reads\ndef find(q):\n    """Find."""\n    return q\n');
  const file = join(work, "company/toolset/acme.py");
  writeFileSync(file, 'from tools.gmail import find\n\n\n# risk: reads\ndef acme(q):\n    """Acme mail."""\n    return find(q)\n');
  const p = Bun.spawnSync(["python3", "-c", "import sys, kernel; print(kernel.check_saved(sys.argv[1]))", file], {
    env: { PATH: process.env.PATH!, PYTHONPATH: join(import.meta.dir, "python"), EMPLIO_WORK: work },
  });
  expect(p.stdout.toString().trim()).toBe("None");
  const { err } = py(`emplio.skill("github-issues")`, { EMPLIO_WORK: work });
  expect(err).toContain("from tools.github_issues import");
});

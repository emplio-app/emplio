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

test("a skill saved with /work paths works where /work is a folder in the person's home", () => {
  const work = mkdtempSync(join(tmpdir(), "work-"));
  mkdirSync(join(work, "company/skills/s"), { recursive: true });
  writeFileSync(join(work, "company/skills/s/functions.py"), `KEY = "/work/tmp/key.pem"\nOTHER = "/workspace/x"\n`);
  const { out, err } = py(`s = emplio.skill("s"); print(s.KEY); print(s.OTHER)`, { EMPLIO_WORK: work });
  expect(err).toBe("");
  expect(out.trim().split("\n")).toEqual([`${work}/tmp/key.pem`, "/workspace/x"]);
});

test("a skill saved on a person's own computer keeps /work, not their folder", () => {
  const work = mkdtempSync(join(tmpdir(), "work-"));
  mkdirSync(join(work, "company/skills/s"), { recursive: true });
  const file = join(work, "company/skills/s/functions.py");
  writeFileSync(file, `KEY = "${work}/restricted/key.pem"\n`);
  const p = Bun.spawnSync(["python3", "-c", "import sys, kernel; print(kernel.check_saved(sys.argv[1]))", file], {
    env: { PATH: process.env.PATH!, PYTHONPATH: join(import.meta.dir, "python"), EMPLIO_WORK: work },
  });
  expect(p.stderr.toString()).toBe("");
  expect(readFileSync(file, "utf8")).toBe(`KEY = "/work/restricted/key.pem"\n`);
});

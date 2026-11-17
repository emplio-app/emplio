import { expect, test } from "bun:test";
import { join } from "node:path";

// emplio.tools (python/py/emplio/_toolset.py) against the real Python session: python/test_toolset.py
test("tools are kept, linked, checked and refused as they should be", () => {
  const p = Bun.spawnSync(["python3", join(import.meta.dir, "python/test_toolset.py")], { env: { PATH: process.env.PATH! } });
  const out = p.stdout.toString();
  if (p.exitCode !== 0) console.log(out.split("\n").filter((l) => !l.startsWith("ok")).join("\n"), p.stderr.toString());
  expect(p.exitCode).toBe(0);
  expect(out).toContain("all passed");
}, 300_000);

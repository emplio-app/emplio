import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kind, newer, swapScript } from "./update.js";

test("each build asks for its own kind of update", () => {
  expect(kind("darwin", "45.3.1")).toBe("darwin");
  expect(kind("darwin", "37.10.3")).toBe("darwin-older");
  expect(kind("win32", "45.3.1")).toBe("win32");
  expect(kind("freebsd", "45.3.1")).toBeNull();
});

test("versions compare by number, not text", () => {
  expect(newer("0.1.10", "0.1.9")).toBe(true);
  expect(newer("0.2.0", "0.2.0")).toBe(false);
  expect(newer("0.1.1", "0.2.0")).toBe(false);
});

test("Linux: once the app quits, the new folder takes the old one's place and opens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "emplio-update-"));
  const install = join(dir, "Emplio linux");
  const fresh = join(dir, ".emplio-update", "Emplio-linux-x64");
  for (const [d, v] of [[install, "old"], [fresh, "new"]]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "version"), v);
    writeFileSync(join(d, "emplio"), `#!/bin/sh\necho opened > "${dir}/opened"\n`, { mode: 0o755 });
  }
  const app = Bun.spawn(["sleep", "1"]);
  const script = join(dir, ".emplio-update", "swap.sh");
  writeFileSync(script, swapScript("linux", { pid: app.pid, install, fresh, open: join(install, "emplio") }));
  const swap = Bun.spawn(["/bin/sh", script]);
  await Bun.sleep(300);
  // still the old one while the app runs
  expect(readFileSync(join(install, "version"), "utf8")).toBe("old");
  await swap.exited;
  // the new app is opened in the background
  for (let i = 0; i < 30 && !existsSync(join(dir, "opened")); i++) await Bun.sleep(100);
  expect(readFileSync(join(install, "version"), "utf8")).toBe("new");
  expect(existsSync(join(dir, "opened"))).toBe(true);
  expect(existsSync(`${install}.old`) || existsSync(join(dir, ".emplio-update"))).toBe(false);
  rmSync(dir, { recursive: true });
});

test("Windows: paths with quotes stay inside their quotes", () => {
  const s = swapScript("win32", { pid: 1, install: "C:\\Users\\O'Neil\\Emplio-win32-x64", fresh: "C:\\Users\\O'Neil\\.emplio-update\\Emplio-win32-x64", open: "C:\\Users\\O'Neil\\Emplio-win32-x64\\Emplio.exe" });
  expect(s).toContain("'C:\\Users\\O''Neil\\Emplio-win32-x64\\Emplio.exe'");
});

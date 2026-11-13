import { expect, test } from "bun:test";
import { folderName, localPath, shellPath, toLocal, toRemote } from "./paths.js";

const work = "/Users/me/Emplio/acme-1a2b3c4d/work";

test("/work becomes the real folder, only where it is a path of its own", () => {
  expect(toLocal("cd /work && ls /work/company", work)).toBe(`cd ${work} && ls ${work}/company`);
  expect(toLocal(`cat "/work/me/a b.md"; echo '/work'`, work)).toBe(`cat "${work}/me/a b.md"; echo '${work}'`);
  expect(toLocal("X=/work/tmp/x.js node $X", work)).toBe(`X=${work}/tmp/x.js node $X`);
  // not somebody else's path
  expect(toLocal("ls ~/work /home/work ./work /workspace https://a.com/work/x", work)).toBe("ls ~/work /home/work ./work /workspace https://a.com/work/x");
});

test("the real folder is /work again in what comes back", () => {
  expect(toRemote(`saved ${work}/out/a.pdf and ${work}`, work)).toBe("saved /work/out/a.pdf and /work");
});

test("a path from the server stays inside the folder", () => {
  expect(localPath(work, "/work/tmp/a.txt")).toBe(`${work}/tmp/a.txt`);
  expect(() => localPath(work, "/work/../.ssh/id_rsa")).toThrow();
  expect(() => localPath(work, "/etc/passwd")).toThrow();
  expect(() => localPath(work, "/workspace/x")).toThrow();
  // the real folder's own path, as a command printed it
  expect(localPath(work, `${work}/out/a.pdf`)).toBe(`${work}/out/a.pdf`);
  expect(() => localPath(work, `${work}/../x`)).toThrow();
});

test("a Windows path as Git Bash writes it", () => {
  expect(shellPath("C:\\Users\\Raj Kumar\\Emplio\\acme-1a2b3c4d\\work")).toBe("/c/Users/Raj Kumar/Emplio/acme-1a2b3c4d/work");
});

test("a business gets a readable folder name", () => {
  expect(folderName("1a2b3c4d-0000-0000-0000-000000000000", "Acme & Sons, Ltd.")).toBe("acme-sons-ltd-1a2b3c4d");
  expect(folderName("1a2b3c4d-0000", "")).toBe("business-1a2b3c4d");
});

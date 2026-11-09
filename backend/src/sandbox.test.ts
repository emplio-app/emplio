import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ask, collectOut, commandEnded, commandStarted, EZ, findOut, MAX_COMMANDS, requestsTrailer, runEz, usesBrowser, withRequests, withRoom } from "./sandbox";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("a command with no start marker finds no files, and find's complaint doesn't read as one", () => {
  const dir = mkdtempSync(join(tmpdir(), "find-out-"));
  mkdirSync(join(dir, "out"));
  writeFileSync(join(dir, "out/a.txt"), "x");
  const run = (others: boolean) => {
    const command = findOut(join(dir, "gone"), others).replaceAll("/work", dir);
    return new TextDecoder().decode(Bun.spawnSync(["bash", "-c", `{ ${command}\n} 2>&1`]).stdout).trim();
  };
  expect(run(true)).toBe("");
  expect(run(false)).toBe(join(dir, "out/a.txt"));
  rmSync(dir, { recursive: true });
});

test("a made file that can't be picked up doesn't throw, stays in out/, and doesn't stop the next one being tried", async () => {
  const tried: string[] = [];
  const removed: string[] = [];
  const box = {
    run: async () => ({ exitCode: 0, result: "/work/out/a.txt\n/work/out/b.txt\n" }),
    read: async (path: string) => {
      tried.push(path);
      throw new Error("no such file");
    },
    remove: async (path: string) => void removed.push(path),
  };
  // these aren't real ids, so the problem's log line is refused and nothing is kept
  const who = { workspaceId: "w", conversationId: "c", role: "owner", user: { id: "u", name: "A", email: "a@example.com" } };
  const made = await collectOut(box as never, who as never, "/work/tmp/.started-x", false);
  expect(made).toEqual({ saved: [], failed: ["a.txt", "b.txt"] });
  expect(tried).toEqual(["/work/out/a.txt", "/work/out/b.txt"]);
  expect(removed).toEqual([]);
});

test("a computer that didn't answer has no made files, rather than its timeout message read as one", async () => {
  const tried: string[] = [];
  const box = { run: async () => ({ exitCode: 124, result: "Command timed out after 60s" }), read: async (path: string) => void tried.push(path) };
  const who = { workspaceId: "w", conversationId: "c", role: "owner", user: { id: "u", name: "A", email: "a@example.com" } };
  expect(await collectOut(box as never, who as never, "/work/tmp/.started-x", false)).toEqual({ saved: [], failed: [] });
  expect(tried).toEqual([]);
});

test("an emplio request that throws keeps the command's output and the requests after it", async () => {
  const who = { workspaceId: "w", conversationId: "c", role: "owner", user: { id: "u", name: "A", email: "a@example.com" } };
  // not a real business id, so the export is refused
  const failing = `EXPORT:k\t${Buffer.from("chats\0").toString("base64")}`;
  const { output } = await runEz({} as never, who as never, `before\n${failing}\nafter`, "k");
  const [first, problem, last] = output.split("\n");
  expect(first).toBe("before");
  expect(problem).toStartWith("error: this emplio request failed, and may or may not have gone through");
  expect(last).toBe("after");
});

test("commands run side by side up to the cap; a save waits for a gap without holding up new commands", async () => {
  const box = crypto.randomUUID();
  const start = () => withRoom(box, MAX_COMMANDS, async () => commandStarted(box));
  await start();
  await start(); // a second command doesn't wait for the first

  let saved = false;
  const save = withRoom(box, 1, async () => void (saved = true));
  await tick();
  expect(saved).toBe(false);
  await start(); // nor for the save that's waiting

  commandEnded(box);
  commandEnded(box);
  await tick();
  expect(saved).toBe(false); // one still running
  commandEnded(box);
  await save;
  expect(saved).toBe(true);

  // over the cap: the next waits until one ends
  for (let i = 0; i < MAX_COMMANDS; i++) await start();
  let extra = false;
  const late = withRoom(box, MAX_COMMANDS, async () => {
    extra = true;
    commandStarted(box);
  });
  await tick();
  expect(extra).toBe(false);
  commandEnded(box);
  await late;
  expect(extra).toBe(true);
  for (let i = 0; i < MAX_COMMANDS; i++) commandEnded(box);
});

test("a step that fails doesn't stop the line", async () => {
  const box = crypto.randomUUID();
  await expect(withRoom(box, 1, async () => { throw new Error("no"); })).rejects.toThrow("no");
  expect(await withRoom(box, 1, async () => "ok")).toBe("ok");
});

test("emplio requests survive pipes that cut or drop their markers", () => {
  const k = "K1";
  const out = [
    "hello",
    `APPS:${k}\t@/tmp/emplio-req.${k}.APPS.aaa`,
    `APPS:${k}\t@/tmp/emplio-req.${k}.AP`, // cut by head -c
    "bye",
    `EZREQ:${k}\t/tmp/emplio-req.${k}.APPS.aaa\tQUJD`,
    `EZREQ:${k}\t/tmp/emplio-req.${k}.APPS.bbb\tREVG`, // marker dropped by grep
    `EZREQ:${k}\t/tmp/emplio-req.${k}.TASK.ccc\tR0hJ`,
  ].join("\n");
  expect(withRequests(out, k)).toBe(["hello", `APPS:${k}\tQUJD`, "bye", `APPS:${k}\tREVG`, `TASK:${k}\tR0hJ`].join("\n"));
  expect(withRequests("plain\ntext", k)).toBe("plain\ntext");
});

test("emplio ask: text from stdin goes on the card, above the question", () => {
  const person = { automation: false, task: false, notify: () => {}, user: { name: "Asha" } } as unknown as Parameters<typeof ask>[0];
  const card = ask(person, ["--text", "  Hi all,\n\nOffice at 9.\n", "Send this?", "Send it", "Change it"]);
  expect(card).toMatchObject({ question: "Send this?", options: ["Send it", "Change it"], text: "Hi all,\n\nOffice at 9." });
  // nothing on stdin: no text, same card
  expect(ask(person, ["--text", "", "Which one?", "A", "B"])).not.toHaveProperty("text");
  expect(ask(person, ["Which one?", "A", "B"])).not.toHaveProperty("text");
  expect(ask(person, ["--text", "x".repeat(3001), "Send this?"])).toStartWith("error:");
});

test("a command that drives the browser is spotted, from the shell or from Python", () => {
  for (const c of ["emplio browser open https://a.com", "ez browser snapshot", `python3 -c 'run(["emplio", "browser", "click", "@e1"])'`]) expect(usesBrowser(c)).toBe(true);
  for (const c of ["emplio web read x", "echo a browser", "emplio browsers"]) expect(usesBrowser(c)).toBe(false);
});

test("a failed browser step shows at the end of the result even when the command hides its output", async () => {
  const home = mkdtempSync(join(tmpdir(), "emplio-"));
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  // stands in for agent-browser: `click @bad` is refused, anything else works
  writeFileSync(join(home, ".local/bin/agent-browser"), `#!/bin/bash\ncase "$*" in *@bad*) echo "✗ covered" >&2; exit 1;; *@cut*) exit 141;; *"eval fn"*) echo "{}";; *"eval ok"*) echo '"200"';; *) echo done;; esac\n`, { mode: 0o755 });
  writeFileSync(join(home, "emplio"), EZ, { mode: 0o755 });
  const key = `test${Date.now()}`;
  const run = async (command: string) => {
    const p = Bun.spawn(["bash", "-c", command + requestsTrailer(key)], {
      env: { HOME: home, PATH: process.env.PATH!, EZ_KEY: key, BROWSER_CDP_URL: "x", BROWSER_SESSION: "s", BROWSER_POINTER: "p" },
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { out: await new Response(p.stdout).text(), code: await p.exited };
  };
  const hidden = await run(`./emplio browser click @bad >/dev/null 2>&1; ./emplio browser click @ok >/dev/null 2>&1`);
  expect(hidden.out).toContain("click @bad: ✗ covered");
  expect(hidden.out).not.toContain("@ok");
  expect(hidden.code).toBe(0);
  expect((await run(`./emplio browser click @ok`)).out).not.toContain("failed");
  expect((await run(`./emplio browser click @cut`)).out).not.toContain("failed"); // | head stopped reading
  // a function written but never called comes back as {}: a failure, so what's chained after it doesn't run
  const uncalled = await run(`./emplio browser eval fn 2>&1 && echo sent`);
  expect(uncalled.out).toContain("never called");
  expect(uncalled.out).toContain("[Browser steps that failed");
  expect(uncalled.out).not.toContain("sent");
  const called = await run(`./emplio browser eval ok`);
  expect(called.out).toContain('"200"');
  expect(called.out).not.toContain("failed");
  rmSync(home, { recursive: true });
});

test("the page's calls show once, without secrets, and send repeats them with the login", async () => {
  const home = mkdtempSync(join(tmpdir(), "emplio-"));
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  const page = "https://app.test/home";
  const records = [
    { requestId: "1", method: "POST", url: "https://app.test/api/items", status: 201, mimeType: "application/json", headers: { Authorization: "Bearer SECRET", Cookie: "c=1", Referer: page } },
    { requestId: "2", method: "GET", url: "https://app.test/api/items/123?page=1", status: 200, mimeType: "application/json", headers: { Authorization: "Bearer SECRET", Referer: page } },
    { requestId: "3", method: "POST", url: "https://ads.test/hit", status: 204, mimeType: "text/plain", headers: { Referer: page } },
  ];
  const details = { 1: { postData: '{"name":"a","password":"hunter2"}', responseBody: '{"id":7,"token":"SECRET2"}' }, 2: { responseBody: '{"data":[{"id":1,"name":"a"}]}' } };
  const fake = `#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
if "--json" in a and "requests" in a: print(json.dumps({"data": {"requests": ${JSON.stringify(records)}}}))
elif "--json" in a and "request" in a:
    i = a[-1]; print(json.dumps({"data": {**next(r for r in ${JSON.stringify(records)} if r["requestId"] == i), **${JSON.stringify(details)}.get(i, {})}}))
elif "eval" in a:
    js = sys.stdin.read()
    if "innerText" in js:
        print(json.dumps(json.dumps({"page": "app.test", "blocked": True, "signIn": False}))); sys.exit()
    open(${JSON.stringify(join(home, "sent.js"))}, "w").write(js)
    status = 422 if "bad" in js else 201
    print(json.dumps(json.dumps({"status": status, "body": '{"id":8,"token":"SECRET3"}'})))
elif "url" in a: print(${JSON.stringify(page)})
`;
  writeFileSync(join(home, ".local/bin/agent-browser"), fake, { mode: 0o755 });
  writeFileSync(join(home, "emplio"), EZ, { mode: 0o755 });
  const key = `test${Date.now()}`;
  const run = async (command: string) => {
    const p = Bun.spawn(["bash", "-c", command + requestsTrailer(key)], {
      env: { HOME: home, PATH: `${home}:${process.env.PATH}`, EZ_KEY: key, BROWSER_CDP_URL: "x", BROWSER_SESSION: `s${key}`, BROWSER_POINTER: "p" },
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { out: await new Response(p.stdout).text(), code: await p.exited };
  };

  // listed once, by shape only: no values, nothing from the ad server, no login
  const first = await run(`true`);
  expect(first.out).toContain("POST /api/items 201 sends {name, password} returns {id, token}");
  expect(first.out).toContain("GET /api/items/*?page= 200 returns {data 1 rows of {id, name}}");
  expect(first.out).toContain("use these directly with emplio browser send");
  expect(first.out).not.toContain("ads.test");
  expect(first.out).not.toContain("SECRET");
  expect(first.out).not.toContain("hunter2");
  // what goes to the server: where and which fields, no values, and nothing from the ad server
  const report = (out: string) => JSON.parse(atob(out.split("\n").find((l) => l.startsWith(`SITECALLS:${key}\t`) || l.startsWith(`EZREQ:${key}\t`))!.split("\t").at(-1)!));
  const told = report(first.out);
  expect(told.page).toBe("app.test");
  expect(told.rows.map((r: { method: string; path: string }) => `${r.method} ${r.path}`)).toEqual(["POST /api/items", "GET /api/items/*"]);
  expect(told.rows[1]).toMatchObject({ host: "app.test", query: "page=", keys: ["data"] });
  expect(JSON.stringify(told)).not.toMatch(/SECRET|hunter2|123/);
  expect((await run(`true`)).out).not.toContain("New calls");
  // a page that turned the browser away is reported after every command
  expect(JSON.parse(atob(first.out.split("\n").find((l) => l.startsWith(`SITECHECK:${key}\t`))!.split("\t").at(-1)!))).toEqual({ page: "app.test", blocked: true, signIn: false });

  const full = await run(`emplio browser calls POST /api/items`);
  expect(full.out).toContain("Headers sent (values hidden): Authorization");
  expect(full.out).not.toMatch(/SECRET|hunter2/);

  // repeated with the login but not the cookie, and the login never shows
  const sent = await run(`emplio browser send POST /api/items '{"name":"b"}'`);
  expect(sent.out).toStartWith("201\n");
  expect(sent.out).not.toContain("SECRET");
  const js = await Bun.file(join(home, "sent.js")).text();
  expect(js).toContain("https://app.test/api/items");
  expect(js).toContain("Bearer SECRET");
  expect(js).not.toContain("c=1");
  // the reply goes to the server to check against last time, even when a pipe hides the output
  // and when output is cut mid-line, the lines after it still come apart
  const cut = await run(`emplio browser send POST /api/items '{"name":"b"}' | head -c 3`);
  const parted = withRequests(cut.out, key).split("\n");
  expect(parted[0]).toBe("201");
  expect(parted.some((l) => l.startsWith(`SITECALLS:${key}\t`))).toBe(true);
  expect(parted.join("\n")).not.toContain("EZREQ");
  const hidden = report((await run(`emplio browser send POST /api/items '{"name":"b"}' | tail -1`)).out);
  expect(hidden.sent).toMatchObject({ method: "POST", path: "/api/items", keys: ["id", "token"], notJson: false });

  // an id in the path, and a refusal counts as a failure even when the output is hidden
  await run(`emplio browser send GET /api/items/999`);
  expect(await Bun.file(join(home, "sent.js")).text()).toContain("/api/items/999");
  const refused = await run(`emplio browser send POST /api/items '{"name":"bad"}' >/dev/null 2>&1 && echo sent`);
  expect(refused.out).not.toContain("sent");
  expect(refused.out).toContain("[Browser steps that failed");
  expect(refused.out).toContain("422");
  rmSync(home, { recursive: true });
});

test("emplio browser run: a saved script drives the browser, takes arguments, and stops at the first failed step", async () => {
  const home = mkdtempSync(join(tmpdir(), "emplio-"));
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/agent-browser"), `#!/bin/bash\ncase "$*" in *@bad*) echo "✗ covered" >&2; exit 1;; *) echo "did $*";; esac\n`, { mode: 0o755 });
  writeFileSync(join(home, "emplio"), EZ, { mode: 0o755 });
  writeFileSync(join(home, "ok.sh"), `emplio browser click "@$1"\n`);
  writeFileSync(join(home, "stops.sh"), `emplio browser click @bad\nemplio browser click @never\n`);
  writeFileSync(join(home, "ok.py"), `import subprocess, sys\nsubprocess.run(["emplio", "browser", "click", "@" + sys.argv[1]], check=True)\n`);
  const key = `test${Date.now()}`;
  const run = async (command: string, attached = true) => {
    const p = Bun.spawn(["bash", "-c", command + requestsTrailer(key)], {
      env: { HOME: home, PATH: `${home}:${process.env.PATH}`, EZ_KEY: key, BROWSER_POINTER: "p", ...(attached ? { BROWSER_CDP_URL: "x", BROWSER_SESSION: "s" } : {}) },
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() };
  };
  expect((await run(`emplio browser run ok.sh one`)).out).toContain("click @one");
  expect((await run(`emplio browser run ok.py two`)).out).toContain("click @two");
  const stopped = await run(`emplio browser run stops.sh`);
  expect(stopped.out).toContain("click @bad: ✗ covered");
  expect(stopped.out).not.toContain("@never");
  expect((await run(`emplio browser run missing.sh`)).err).toContain("usage: emplio browser run");
  expect((await run(`bash ok.sh one`, false)).err).toContain("emplio browser run <script>");
  rmSync(home, { recursive: true });
});

test("emplio hand and report read what's on stdin, and old emplio jobs points to them", async () => {
  const home = mkdtempSync(join(tmpdir(), "emplio-"));
  writeFileSync(join(home, "emplio"), EZ, { mode: 0o755 });
  const key = `test${Date.now()}`;
  const run = async (command: string) => {
    const p = Bun.spawn(["bash", "-c", command + requestsTrailer(key)], { env: { HOME: home, PATH: process.env.PATH!, EZ_KEY: key }, cwd: home, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
    const line = withRequests(out, key).split("\n").find((l) => l.includes(`:${key}\t`));
    return { args: line ? Buffer.from(line.split("\t")[1]!, "base64").toString().split("\0").slice(0, -1) : [], tag: line?.split(":")[0], err, code };
  };
  expect((await run(`./emplio hand "Book Keeper" <<'EOF'\nOctober fixes\nEOF`)).args).toEqual(["hand", "Book Keeper", "October fixes\n".trimEnd()]);
  expect((await run(`./emplio hand "Book Keeper" --description "Keeps books" <<'EOF'\nthe brief\nEOF`)).args).toEqual(["hand", "Book Keeper", "--description", "Keeps books", "the brief"]);
  expect((await run(`./emplio hand a1b2c3d4 "carry on"`)).args).toEqual(["hand", "a1b2c3d4", "carry on"]);
  expect((await run(`./emplio hand help`)).args).toEqual(["hand", "help"]);
  expect((await run(`./emplio threads list`)).args).toEqual(["list"]);
  const report = await run(`./emplio report "send fails" <<'EOF'\nthe error\nEOF`);
  expect(report.tag).toBe("REPORT");
  expect(report.args).toEqual(["send fails", "the error"]);
  const old = await run(`./emplio jobs start x <<'EOF'\nbrief\nEOF`);
  expect(old.args).toEqual([]);
  expect(old.err).toContain("emplio hand");
});

// The gatekeeper's rules, against a stand-in for Docker that records what it was asked. docker/smoke.sh tests real Docker.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "runner-test-"));
const log = join(dir, "log");
const ID = "abc123abc123";
writeFileSync(
  join(dir, "docker"),
  `#!/bin/bash
printf '%s\\n' "$*" >> ${log}
case "$1" in
  network) exit 0 ;;
  ps) echo ${ID} ;;
  run) echo ${ID} ;;
  stop|rm|start) exit 0 ;;
  inspect)
    kind=computer; [ "$2" = other123other ] && kind=other
    echo '[{"Id":"'$2'","State":{"Running":'"$( [ -f ${dir}/stopped ] && echo false || echo true )"'},"Config":{"Labels":{"emplio.kind":"'$kind'","emplio.employee0User":"u"}},"NetworkSettings":{"Networks":{"n":{"IPAddress":"10.88.0.2"}}}}]' ;;
  exec)
    case "$*" in *resolv.conf*) exit 0 ;; esac
    shift
    while [ "$1" != ${ID} ]; do case "$1" in -w|-u) shift 2 ;; -e|-i) [ "$1" = -e ] && shift; shift ;; esac; done
    shift
    exec "$@" ;;
esac
`,
);
chmodSync(join(dir, "docker"), 0o755);
// timeout isn't on every machine: this one just runs the command
writeFileSync(join(dir, "timeout"), `#!/bin/bash\nshift 3\nexec "$@"\n`);
chmodSync(join(dir, "timeout"), 0o755);

const TOKEN = "t".repeat(40);
const PORT = 41873;
const server = Bun.spawn(["bun", join(import.meta.dir, "runner.ts")], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TOKEN: TOKEN, PORT: String(PORT) }, stdout: "ignore", stderr: "ignore" });
const call = (path: string, init: RequestInit = {}, token = TOKEN) => fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { authorization: `Bearer ${token}` } });
for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });
const asked = () => readFileSync(log, "utf8");

afterAll(() => {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
});

test("needs the token", async () => {
  expect((await call("/computers?labels={}", {}, "wrong".repeat(8))).status).toBe(401);
  expect((await fetch(`http://127.0.0.1:${PORT}/computers?labels={}`)).status).toBe(401);
});

test("makes computers from our image with fixed limits, whatever is asked", async () => {
  const r = await post("/computers", { labels: { employee0User: "u", employee0Workspace: "w" }, ms: 60_000, image: "evil", privileged: true, volumes: ["/:/host"] });
  expect(((await r.json()) as { id: string }).id).toBe(ID);
  const run = asked().split("\n").find((l) => l.startsWith("run ") && l.includes("emplio.kind=computer"))!; // not the firewall run before it
  expect(run).toEndWith("emplio-computer");
  expect(run).toContain("--memory");
  for (const bad of ["evil", "--privileged", "/:/host", "docker.sock", "-v "]) expect(run).not.toContain(bad);
});

test("refuses labels that could be options", async () => {
  expect((await post("/computers", { labels: { "--privileged": "x" }, ms: 1000 })).status).toBe(400);
  expect((await post("/computers", { labels: { a: "x y" }, ms: 1000 })).status).toBe(400);
});

test("only touches containers it made", async () => {
  expect((await post("/computers/other123other/run", { command: "true", timeoutMs: 1000 })).status).toBe(400);
  expect((await call("/computers/other123other", { method: "DELETE" })).status).toBe(400);
  expect((await post("/computers/not-an-id/run", { command: "true", timeoutMs: 1000 })).status).toBe(400);
});

test("runs a command, with env values kept off the command line", async () => {
  const r = await post(`/computers/${ID}/run`, { command: 'echo "$SECRET_THING"; exit 3', cwd: "/", env: { SECRET_THING: "hunter2" }, timeoutMs: 5000 });
  expect(await r.json()).toEqual({ exitCode: 3, result: "hunter2\n" });
  expect(asked()).toContain("-e SECRET_THING");
  expect(asked()).not.toContain("hunter2");
  expect((await post(`/computers/${ID}/run`, { command: "true", env: { "A B": "x" }, timeoutMs: 5000 })).status).toBe(400);
});

test("writes, reads and removes a file", async () => {
  const path = join(dir, "sub/folder/file.bin");
  const at = `/computers/${ID}/file?path=${encodeURIComponent(path)}`;
  const bytes = new Uint8Array([0, 255, 10, 13, 65]);
  expect((await call(at, { method: "PUT", body: bytes })).ok).toBe(true);
  expect(new Uint8Array(await (await call(at)).arrayBuffer())).toEqual(bytes);
  expect((await call(at, { method: "DELETE" })).ok).toBe(true);
  expect((await call(at)).status).toBe(404);
});

test("a sleeping computer refuses to stay awake, and wakes when asked", async () => {
  writeFileSync(join(dir, "stopped"), "");
  expect((await post(`/computers/${ID}/keep`, { ms: 1000 })).status).toBe(409);
  const found = (await (await call(`/computers?labels=${encodeURIComponent('{"employee0User":"u"}')}`)).json()) as { asleep: boolean; labels: Record<string, string> }[];
  expect(found[0]!.asleep).toBe(true);
  expect(found[0]!.labels.employee0User).toBe("u");
  expect((await post(`/computers/${ID}/wake`, { ms: 1000 })).ok).toBe(true);
  expect(asked()).toContain(`start ${ID}`);
  rmSync(join(dir, "stopped"));
});

test("goes to sleep after the time it was given", async () => {
  await post(`/computers/${ID}/keep`, { ms: 100 });
  await Bun.sleep(400);
  expect(asked()).toContain(`stop -t 3 ${ID}`);
});

test("on a server that only holds computers: its runtime, name servers, no app to join, preview links", async () => {
  const port = PORT + 1;
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TOKEN: TOKEN, PORT: String(port), APP_CONTAINER: "", COMPUTER_RUNTIME: "runsc", COMPUTER_DNS: "1.1.1.1,bad;rm", PREVIEW_DOMAIN: "box.test" };
  const other = Bun.spawn(["bun", join(import.meta.dir, "runner.ts")], { env, stdout: "ignore", stderr: "ignore" });
  try {
    for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
    writeFileSync(log, "");
    await fetch(`http://127.0.0.1:${port}/computers`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ labels: { employee0User: "v" }, ms: 60_000 }) });
    const lines = asked().split("\n");
    expect(lines.find((l) => l.startsWith("run ") && l.includes("emplio.kind=computer"))).toContain("--runtime runsc");
    expect(lines.some((l) => l.startsWith("network connect"))).toBe(false);
    const dns = lines.find((l) => l.includes("resolv.conf"))!;
    expect(dns).toContain("nameserver 1.1.1.1");
    expect(dns).not.toContain("rm");
    const ok = (host: string) => fetch(`http://127.0.0.1:${port}/preview-ok?domain=${host}`).then((r) => r.status);
    expect(await ok(`3000-${ID}.box.test`)).toBe(200);
    expect(await ok(`3000-${ID}.evil.test`)).toBe(404);
    expect(await ok(`3000-other123other.box.test`)).toBe(404);
  } finally {
    other.kill();
  }
});

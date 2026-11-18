// The gatekeeper between Emplio and Docker. Control of Docker is control of the whole machine, so only this small
// program holds it, and all it can do is start, stop and use containers made from our two images, with fixed limits:
// never privileged, never with a folder from the machine, never with Docker itself inside. Nothing can ask it for
// another image or other options. It has no public port, and every request needs RUNNER_TOKEN.
// Each person gets their own Docker network, holding their computer and browsers and no one else's. Emplio joins
// each network to reach the browsers. Those networks can't reach Postgres, Gitea or this program, or the cloud
// metadata address where a server's own credentials are handed out (blockMetadata).
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as gvisor from "./gvisor";

const TOKEN = process.env.RUNNER_TOKEN;
if (!TOKEN || TOKEN.length < 32) throw new Error("RUNNER_TOKEN must be set, at least 32 characters");
const COMPUTER_IMAGE = process.env.COMPUTER_IMAGE ?? "emplio-computer";
const BROWSER_IMAGE = process.env.BROWSER_IMAGE ?? "emplio-browser";
// Emplio's own container, joined to each person's network to reach the browsers; empty when Emplio runs on another
// machine and only talks to this program (a server that only holds computers)
const APP_CONTAINER = process.env.APP_CONTAINER ?? "emplio-app";
// another runtime for the containers, like gVisor's runsc, which gives each one its own small kernel
const RUNTIME = process.env.COMPUTER_RUNTIME ? ["--runtime", process.env.COMPUTER_RUNTIME] : [];
// memory-swap the same as memory: no spilling into the machine's swap, which would let one computer use far more
const MEMORY = process.env.COMPUTER_MEMORY ?? "2g";
const LIMITS = [...RUNTIME, "--memory", MEMORY, "--memory-swap", MEMORY, "--cpus", process.env.COMPUTER_CPUS ?? "2", "--pids-limit", "1024"];
// name servers written into a computer each time it starts, for runtimes that can't use Docker's own (gVisor on a
// person's network): "1.1.1.1,8.8.8.8"
const DNS = (process.env.COMPUTER_DNS ?? "").split(",").filter((ip) => /^[0-9a-f.:]+$/i.test(ip));
// preview links: a server a computer runs on a port opens at https://<port>-<computer's 12-letter id>.<this domain>
const PREVIEW_DOMAIN = process.env.PREVIEW_DOMAIN ?? "";
// runsc: computers run by gVisor directly (gvisor.ts), which can bring a sleeping one back with everything running
const GVISOR = process.env.COMPUTER_ENGINE === "runsc";
const BROWSER_HOURS = 4;
const MAX_OUTPUT = 20 * 1024 * 1024;

const LABEL_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const LABEL_VALUE = /^[A-Za-z0-9_.:-]{0,128}$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

class Refused extends Error {}

function checkLabels(labels: unknown): Record<string, string> {
  if (!labels || typeof labels !== "object") throw new Refused("labels needed");
  for (const [k, v] of Object.entries(labels)) if (!LABEL_KEY.test(k) || typeof v !== "string" || !LABEL_VALUE.test(v)) throw new Refused(`bad label ${k}`);
  return labels as Record<string, string>;
}

type Done = { code: number; out: Uint8Array; err: string; late?: boolean };
async function docker(args: string[], o: { stdin?: Uint8Array; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<Done> {
  const p = Bun.spawn(["docker", ...args], {
    ...(o.timeoutMs && { timeout: o.timeoutMs }),
    stdin: o.stdin ? new Blob([o.stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...o.env },
  });
  const started = Date.now();
  const [out, err, code] = await Promise.all([new Response(p.stdout).bytes(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err, late: !!o.timeoutMs && Date.now() - started >= o.timeoutMs };
}
const text = (d: Done) => new TextDecoder().decode(d.out).trim();
async function must(args: string[]) {
  const d = await docker(args);
  if (d.code) throw new Error(`docker ${args[0]} failed: ${d.err.trim()}`);
  return text(d);
}

type Inspected = { Id: string; State: { Running: boolean }; Config: { Labels: Record<string, string> | null }; NetworkSettings: { Networks: Record<string, { IPAddress: string }> } };
const inspect = async (id: string) => (JSON.parse(await must(["inspect", id])) as Inspected[])[0]!;

// only containers we made: the id in a request can't point at anything else on the machine
async function ours(id: string, kind: "computer" | "browser") {
  if (!CONTAINER_ID.test(id)) throw new Refused("bad id");
  const c = await inspect(id).catch(() => null);
  if (c?.Config.Labels?.["emplio.kind"] !== kind) throw new Refused("no such container");
  return c;
}

async function list(kind: string, labels: Record<string, string>) {
  const filters = [`label=emplio.kind=${kind}`, ...Object.entries(labels).map(([k, v]) => `label=emplio.${k}=${v}`)];
  const ids = (await must(["ps", "-aq", "--no-trunc", ...filters.flatMap((f) => ["--filter", f])])).split("\n").filter(Boolean);
  return Promise.all(ids.map(inspect));
}

// /28s in 10.88.0.0/16: room for 4096 people's networks (a computer and a few browsers each)
const SUBNETS = 4096;
const subnet = (i: number) => `10.88.${i >> 4}.${(i & 15) * 16}/28`;

// A rule on the machine itself, since a container can't be trusted with its own: nothing in those networks reaches the
// clouds' metadata addresses. It takes one short-lived container with the machine's network, running only this.
// Both kinds of iptables, since a machine's Docker can use either. Rules are gone after a reboot, and so is this program.
const METADATA = ["169.254.0.0/16", "100.100.100.200/32"];
const FIREWALL = `set -e; done=
for t in iptables-nft iptables-legacy; do
  $t -nL DOCKER-USER >/dev/null 2>&1 || continue
  for to in ${METADATA.join(" ")}; do $t -C DOCKER-USER -s 10.88.0.0/16 -d $to -j DROP 2>/dev/null || $t -I DOCKER-USER -s 10.88.0.0/16 -d $to -j DROP; done
  done=1
done
[ -n "$done" ]`;
let blocked = false;
async function blockMetadata() {
  if (blocked) return;
  const d = await docker(["run", "--rm", "--network", "host", "--cap-add", "NET_ADMIN", "--user", "root", "--entrypoint", "sh", COMPUTER_IMAGE, "-c", FIREWALL]);
  blocked = !d.code;
  // ponytail: carries on without it, so Docker setups with no such firewall (rootless) still work; only a cloud server minds
  if (d.code) console.error(`WARNING: couldn't block the cloud metadata address. On a cloud server, computers may be able to read its credentials. ${d.err.trim()}`);
}
// A person's own network, with Emplio joined to it. Explicit addresses, since Docker's own pool runs out at about 30.
async function networkOf(person: string) {
  await blockMetadata();
  const name = `emplio-net-${createHash("sha256").update(person).digest("hex").slice(0, 16)}`;
  if ((await docker(["network", "inspect", name])).code) {
    const start = parseInt(name.slice(-3), 16) % SUBNETS;
    let made = false, last = "";
    for (let i = 0; i < SUBNETS && !made; i++) {
      const d = await docker(["network", "create", "--label", "emplio.kind=network", "--subnet", subnet((start + i) % SUBNETS), name]);
      made = !d.code || /already exists/.test(d.err);
      last = d.err;
    }
    if (!made) throw new Error(`couldn't make a network: ${last.trim()}`);
  }
  if (APP_CONTAINER) {
    const joined = await docker(["network", "connect", name, APP_CONTAINER]);
    if (joined.code && !/already exists|already attached/.test(joined.err)) throw new Error(`couldn't join the network: ${joined.err.trim()}`);
  }
  return name;
}

// Docker writes /etc/resolv.conf again on every start, so this goes in after each one
async function setDns(id: string) {
  if (!DNS.length) return;
  await must(["exec", "-u", "root", id, "sh", "-c", `printf '${DNS.map((ip) => `nameserver ${ip}\\n`).join("")}' > /etc/resolv.conf`]);
}
const personOf = (labels: Record<string, string>) => `${labels.employee0Workspace ?? ""}:${labels.employee0User ?? ""}`;

// Asleep after this long unless told again. Stopped rather than paused, so a sleeping computer frees its memory;
// its files stay, what was running doesn't (gvisor.ts keeps that too).
const IDLE_MS = 5 * 60_000;
const sleepers = new Map<string, Timer>();
function sleepAfter(id: string, ms: number) {
  clearTimeout(sleepers.get(id));
  const timer = setTimeout(() => {
    if (sleepers.get(id) !== timer) return;
    sleepers.delete(id);
    void docker(["stop", "-t", "3", id]);
  }, ms);
  sleepers.set(id, timer);
}
// timers live in memory: after a restart, every computer still awake gets one again
if (!GVISOR) void docker(["ps", "-q", "--no-trunc", "--filter", "label=emplio.kind=computer"]).then((d) => text(d).split("\n").filter(Boolean).forEach((id) => sleepAfter(id, IDLE_MS)));
const asMs = (ms: unknown) => {
  if (typeof ms !== "number" || !(ms > 0) || ms > 7 * 86_400_000) throw new Refused("bad ms");
  return ms;
};

// Always started, even when it looks awake: it may be on its way to sleep. One that won't start is removed, so
// Emplio makes a fresh one (its work is saved elsewhere).
async function wake(c: Inspected, ms: number) {
  clearTimeout(sleepers.get(c.Id));
  await networkOf(personOf(labelsOf(c)));
  const d = await docker(["start", c.Id]);
  if (d.code) {
    sleepers.delete(c.Id);
    await docker(["rm", "-f", c.Id]);
    throw new Error(`the computer wouldn't start, so it was removed: ${d.err.trim()}`);
  }
  await setDns(c.Id);
  sleepAfter(c.Id, ms);
}

const labelsOf = (c: Inspected) => Object.fromEntries(Object.entries(c.Config.Labels ?? {}).filter(([k]) => k.startsWith("emplio.")).map(([k, v]) => [k.slice("emplio.".length), v]));

async function runIn(id: string, body: { command?: unknown; cwd?: unknown; env?: unknown; timeoutMs?: unknown }, signal: AbortSignal) {
  if (typeof body.command !== "string") throw new Refused("command needed");
  const seconds = Math.max(1, Math.ceil(asMs(body.timeoutMs) / 1000));
  const env = (body.env ?? {}) as Record<string, string>;
  // names only on the command line, values in the environment, so they don't show in a process list
  for (const [k, v] of Object.entries(env)) if (!ENV_NAME.test(k) || typeof v !== "string") throw new Refused(`bad env ${k}`);
  const run = randomUUID();
  const kill = () => void docker(["exec", id, "sh", "-c", `kill -TERM "$(cat /tmp/.run-${run})" 2>/dev/null`]);
  signal.addEventListener("abort", kill, { once: true });
  const args = ["exec", ...(typeof body.cwd === "string" ? ["-w", body.cwd] : []), ...Object.keys(env).flatMap((k) => ["-e", k]), id];
  // $$ stays timeout's own pid after exec: it leads the command's process group, and passes a TERM on to all of it
  const script = `echo $$ > /tmp/.run-${run}; exec timeout -k 5 ${seconds} bash -c "$0"`;
  // and from outside too, in case the computer itself hangs
  const d = await docker([...args, "bash", "-c", script, body.command], { env, timeoutMs: (seconds + 20) * 1000 }).finally(() => signal.removeEventListener("abort", kill));
  if (d.late) return Response.json({ exitCode: 124, result: `The computer didn't answer within ${seconds}s` });
  void docker(["exec", id, "rm", "-f", `/tmp/.run-${run}`]);
  const out = new TextDecoder().decode(d.out.slice(0, MAX_OUTPUT)) + d.err;
  // gVisor stops the whole computer when it goes over its memory, while Docker still calls it running: start it again
  if (d.code === 128 && /WaitPID"? failed|in state stopped/.test(d.err)) {
    await must(["restart", "-t", "1", id]);
    await setDns(id);
    return Response.json({ exitCode: 137, result: `The computer ran out of memory (${MEMORY}) and restarted: files are kept, programs that were running stopped. Use less memory at once (smaller batches, streaming instead of loading whole files).` });
  }
  return Response.json(d.code === 124 ? { exitCode: 124, result: `Command timed out after ${seconds}s` } : { exitCode: d.code, result: out });
}

const browserOf = (c: Inspected) => {
  const ip = Object.values(c.NetworkSettings.Networks)[0]?.IPAddress;
  const labels = c.Config.Labels ?? {};
  return { id: c.Id, cdpUrl: `http://${ip}:9222`, timeoutAt: new Date(Number(labels["emplio.ends"])).toISOString(), startedAt: new Date(Number(labels["emplio.started"])).toISOString() };
};

async function route(req: Request, url: URL): Promise<Response> {
  const [, kind, id, what] = url.pathname.split("/");
  const json = () => req.json().catch(() => ({})) as Promise<Record<string, unknown>>;

  if (kind === "computers" && GVISOR) {
    if (!id && req.method === "GET") return Response.json(await gvisor.list(checkLabels(JSON.parse(url.searchParams.get("labels") ?? "{}"))));
    if (!id && req.method === "POST") {
      const body = await json();
      return Response.json({ id: await gvisor.create(checkLabels(body.labels), asMs(body.ms)) });
    }
    const m = gvisor.find(id!);
    if (!m) throw new Refused("no such container");
    if (!what && req.method === "DELETE") return gvisor.remove(m.id).then(() => Response.json({ ok: true }));
    if (what === "wake" && req.method === "POST") return gvisor.wake(m, asMs((await json()).ms)).then(() => Response.json({ ok: true }));
    if (what === "keep" && req.method === "POST") return (await gvisor.keep(m, asMs((await json()).ms))) ? Response.json({ ok: true }) : new Response("asleep", { status: 409 });
    if (what === "run" && req.method === "POST") {
      const body = await json();
      asMs(body.timeoutMs);
      return gvisor.run(m, body, req.signal);
    }
    if (what === "file") {
      const path = url.searchParams.get("path");
      if (!path) throw new Refused("path needed");
      if (["GET", "PUT", "DELETE"].includes(req.method)) return gvisor.file(m, req.method, path, req.method === "PUT" ? await req.arrayBuffer() : undefined);
    }
  }
  if (kind === "computers") {
    if (!id && req.method === "GET") {
      const found = await list("computer", checkLabels(JSON.parse(url.searchParams.get("labels") ?? "{}")));
      return Response.json(found.map((c) => ({ id: c.Id, labels: labelsOf(c), asleep: !c.State.Running })));
    }
    if (!id && req.method === "POST") {
      const body = await json();
      const labels = checkLabels(body.labels);
      const ms = asMs(body.ms);
      const net = await networkOf(personOf(labels));
      const made = await must(["run", "-d", "--init", "--network", net, ...LIMITS, "--label", "emplio.kind=computer", ...Object.entries(labels).flatMap(([k, v]) => ["--label", `emplio.${k}=${v}`]), COMPUTER_IMAGE]);
      await setDns(made);
      sleepAfter(made, ms);
      return Response.json({ id: made });
    }
    const c = await ours(id!, "computer");
    if (!what && req.method === "DELETE") {
      clearTimeout(sleepers.get(c.Id));
      sleepers.delete(c.Id);
      await must(["rm", "-f", c.Id]);
      return Response.json({ ok: true });
    }
    if (what === "wake" && req.method === "POST") {
      await wake(c, asMs((await json()).ms));
      return Response.json({ ok: true });
    }
    if (what === "keep" && req.method === "POST") {
      const ms = asMs((await json()).ms);
      if (!c.State.Running) return new Response("asleep", { status: 409 });
      sleepAfter(c.Id, ms);
      return Response.json({ ok: true });
    }
    if (what === "run" && req.method === "POST") return runIn(c.Id, await json(), req.signal);
    if (what === "file") {
      const path = url.searchParams.get("path");
      if (!path) throw new Refused("path needed");
      if (req.method === "GET") {
        const d = await docker(["exec", c.Id, "cat", path]);
        return d.code ? new Response(d.err, { status: 404 }) : new Response(d.out);
      }
      if (req.method === "PUT") {
        const d = await docker(["exec", "-i", c.Id, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], { stdin: new Uint8Array(await req.arrayBuffer()) });
        return d.code ? new Response(d.err, { status: 500 }) : Response.json({ ok: true });
      }
      if (req.method === "DELETE") {
        const d = await docker(["exec", c.Id, "rm", "-rf", "--", path]);
        return d.code ? new Response(d.err, { status: 500 }) : Response.json({ ok: true });
      }
    }
  }

  if (kind === "browsers") {
    if (!id && req.method === "GET") {
      const found = await list("browser", checkLabels({ chat: url.searchParams.get("chat") ?? "" }));
      const live = found.filter((c) => c.State.Running && Number(c.Config.Labels?.["emplio.ends"]) > Date.now());
      for (const c of found) if (!live.includes(c)) void docker(["rm", "-f", c.Id]);
      return Response.json(live.map(browserOf));
    }
    if (!id && req.method === "POST") {
      const body = await json();
      const labels = checkLabels({ chat: body.chat, employee0Workspace: body.workspaceId, employee0User: body.userId });
      const net = await networkOf(personOf(labels));
      const started = Date.now();
      const ends = started + BROWSER_HOURS * 3_600_000;
      const made = await must(["run", "-d", "--init", "--network", net, ...LIMITS, "--shm-size", "1g", "--label", "emplio.kind=browser", "--label", `emplio.chat=${labels.chat}`, "--label", `emplio.started=${started}`, "--label", `emplio.ends=${ends}`, BROWSER_IMAGE]);
      setTimeout(() => void docker(["rm", "-f", made]), ends - started);
      return Response.json(browserOf(await inspect(made)));
    }
    const c = await ours(id!, "browser");
    if (!what && req.method === "DELETE") {
      await must(["rm", "-f", c.Id]);
      return Response.json({ ok: true });
    }
    if (what === "downloads" && req.method === "GET") {
      const d = await docker(["exec", c.Id, "find", "/downloads", "-type", "f", "-printf", "%P\t%s\t%T@\n"]);
      const files = text(d).split("\n").filter(Boolean).map((line) => {
        const [path, size, at] = line.split("\t");
        return { path: path!, size: Number(size), lastModified: new Date(Number(at) * 1000).toISOString() };
      });
      return Response.json(d.code ? [] : files);
    }
    if (what === "download" && req.method === "GET") {
      const d = await docker(["exec", c.Id, "cat", "--", `/downloads/${(url.searchParams.get("path") ?? "").replaceAll("..", "")}`]);
      return d.code ? new Response(d.err, { status: 404 }) : new Response(d.out);
    }
  }
  return new Response("Not found", { status: 404 });
}

const allowed = (given: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Preview links: Caddy, in front, asks here which computer and port a link's address means (forward_auth), and
// passes the request on itself (websockets, compression and all). No token: the link itself is the key. A sleeping
// computer is woken, but what served the page stopped when it slept.
const PREVIEW_HOST = /^(\d{1,5})-([a-f0-9]{12})\.(.+)$/;
function previewName(host: string | null) {
  const m = PREVIEW_DOMAIN ? PREVIEW_HOST.exec((host ?? "").split(":")[0]!.toLowerCase()) : null;
  return m && m[3] === PREVIEW_DOMAIN && Number(m[1]) <= 65535 ? { id: m[2]!, port: m[1]! } : null;
}
async function previewOf(host: string | null) {
  const n = previewName(host);
  if (!n) return null;
  if (GVISOR) return gvisor.find(n.id) ? { c: null, port: n.port } : null;
  const c = await ours(n.id, "computer").catch(() => null);
  return c && { c, port: n.port };
}
const ASLEEP = `<!doctype html><meta name="viewport" content="width=device-width"><title>Asleep</title>
<body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">This preview was asleep</h1>
<p>Its computer just woke up, but what showed this page stopped while it slept. Ask Emplio to start it again, then reload.</p>`;
async function previewTarget(host: string | null) {
  if (GVISOR) {
    const n = previewName(host);
    const to = n && (await gvisor.previewTarget(n.id, n.port));
    return to ? new Response(null, { status: 204, headers: { "x-preview-to": to } }) : new Response("Not found", { status: 404 });
  }
  const p = await previewOf(host);
  if (!p?.c) return new Response("Not found", { status: 404 });
  if (!p.c.State.Running) {
    await wake(p.c, 5 * 60_000);
    return new Response(ASLEEP, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "30" } });
  }
  const ip = Object.values(p.c.NetworkSettings.Networks)[0]?.IPAddress;
  return new Response(null, { status: 204, headers: { "x-preview-to": `${ip}:${p.port}` } });
}

// Computers asleep this many days are deleted, to free their disk; Emplio makes a fresh one if that person comes back
// (their work is saved elsewhere). Unset keeps them forever.
const FORGET_DAYS = Number(process.env.COMPUTER_FORGET_DAYS ?? 0);
async function forgetOld() {
  const cutoff = Date.now() - FORGET_DAYS * 86_400_000;
  const ids = text(await docker(["ps", "-aq", "--no-trunc", "--filter", "label=emplio.kind=computer", "--filter", "status=exited"])).split("\n").filter(Boolean);
  for (const id of ids) {
    const finished = Date.parse(text(await docker(["inspect", "-f", "{{.State.FinishedAt}}", id])));
    if (finished && finished < cutoff) await docker(["rm", id]);
  }
  // and the network of anyone left with nothing on it (a sleeping computer still needs its own)
  const nets = text(await docker(["network", "ls", "-q", "--filter", "label=emplio.kind=network"])).split("\n").filter(Boolean);
  for (const net of nets) if (!text(await docker(["ps", "-aq", "--filter", `network=${net}`]))) await docker(["network", "rm", net]);
}
if (GVISOR) await gvisor.resume();
if (FORGET_DAYS > 0) {
  const forget = () => (GVISOR ? gvisor.forgetOld(FORGET_DAYS) : forgetOld());
  setInterval(() => void forget().catch((error) => console.error("forgetting old computers failed", error)), 3_600_000);
  void forget().catch(() => {});
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4100),
  // a server that only holds computers: listen on localhost, behind the HTTPS proxy
  ...(process.env.HOST && { hostname: process.env.HOST }),
  // a command can run for a long time with nothing on the wire
  idleTimeout: 0,
  maxRequestBodySize: 200 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    // Caddy asks where a preview link goes
    if (url.pathname === "/preview-target") return previewTarget(req.headers.get("x-forwarded-host"));
    const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    if (!allowed(given)) return new Response("Unauthorized", { status: 401 });
    try {
      return await route(req, url);
    } catch (error) {
      if (error instanceof Refused) return new Response(error.message, { status: 400 });
      console.error(req.method, url.pathname, error);
      return new Response(error instanceof Error ? error.message : "failed", { status: 500 });
    }
  },
});
console.log(`computer runner on :${server.port}`);

// Computers run by gVisor (runsc) directly, without Docker, on a server that only holds computers
// (COMPUTER_ENGINE=runsc). The reason: gVisor can save a sleeping computer's memory to disk and bring it back in a
// fraction of a second with everything still running, and Docker's own way to do that is broken (moby#50750).
// Docker is still used to build the image, which is unpacked once into a folder every computer shares.
//
// Each computer: its files in a folder of its own over the shared image (overlayfs, so they stay when it sleeps),
// its own network namespace on one bridge where computers can't see each other, and inside it a small helper
// (docker/computer-helper.js) that runs commands and reads and writes files. Commands go through the helper rather
// than `runsc exec`, because what an exec starts doesn't survive a restore.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.COMPUTER_DIR ?? "/var/lib/emplio";
const IMAGE = process.env.COMPUTER_IMAGE ?? "emplio-computer";
const RUNSC = ["runsc", "--root", "/run/emplio", "--allow-suid", "--overlay2=none"];
const BRIDGE = "emplio0";
const GATEWAY = "10.88.0.1";
const HELPER = 49983;
const MEMORY = process.env.COMPUTER_MEMORY ?? "2g";
const CPUS = Number(process.env.COMPUTER_CPUS ?? 2);
const DNS = (process.env.COMPUTER_DNS ?? "1.1.1.1,8.8.8.8").split(",").filter((ip) => /^[0-9a-f.:]+$/i.test(ip));
const USER = { uid: 1001, gid: 1001 };

type Meta = { id: string; labels: Record<string, string>; ip: string; token: string; image: string; created: number; slept?: number };
type Done = { code: number; out: string; err: string };

async function sh(args: string[], quiet = false): Promise<Done> {
  const p = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code && !quiet) console.error(`${args.slice(0, 3).join(" ")} failed: ${err.trim()}`);
  return { code, out, err };
}
async function must(args: string[]) {
  const d = await sh(args, true);
  if (d.code) throw new Error(`${args[0]} ${args[1]} failed: ${d.err.trim()}`);
  return d.out.trim();
}

// runsc run and restore leave the computer holding whatever output they were given: a file, not a pipe that would
// never close
async function detached(id: string, args: string[]) {
  const log = join(dirOf(id), "runsc.log");
  const p = Bun.spawn(args, { stdin: "ignore", stdout: "ignore", stderr: Bun.file(log) });
  const code = await p.exited;
  return { code, out: "", err: code ? readFileSync(log, "utf8").slice(-2000) : "" };
}

const dirOf = (id: string) => join(BASE, "c", id);
const metaOf = (id: string): Meta | null => {
  try {
    return JSON.parse(readFileSync(join(dirOf(id), "meta.json"), "utf8"));
  } catch {
    return null;
  }
};
const save = (m: Meta) => writeFileSync(join(dirOf(m.id), "meta.json"), JSON.stringify(m));
const all = () => (existsSync(join(BASE, "c")) ? readdirSync(join(BASE, "c")).map(metaOf).filter((m): m is Meta => !!m) : []);
const bytes = (size: string) => Number(size.replace(/[a-z]+$/i, "")) * 1024 ** Math.max(0, "bkmg".indexOf(size.slice(-1).toLowerCase()));

// One thing at a time per computer: a wake racing a sleep would otherwise start it twice or save it half-way.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
  queues.set(id, next);
  return next;
}

// The bridge, the way out to the internet, and what computers may not reach: other computers (isolated ports),
// the hosting provider's metadata address, and mail (spam gets the whole server locked). Again at every start, since a
// reboot clears them.
export async function ensureNetwork() {
  await sh(["ip", "link", "add", BRIDGE, "type", "bridge"], true);
  await sh(["ip", "addr", "add", `${GATEWAY}/16`, "dev", BRIDGE], true);
  await must(["ip", "link", "set", BRIDGE, "up"]);
  await must(["sysctl", "-qw", "net.ipv4.ip_forward=1"]);
  const rule = async (table: string, chain: string, spec: string[]) => {
    if ((await sh(["iptables", "-t", table, "-C", chain, ...spec], true)).code) await must(["iptables", "-t", table, "-A", chain, ...spec]);
  };
  await sh(["iptables", "-N", "EMPLIO"], true);
  if ((await sh(["iptables", "-C", "FORWARD", "-j", "EMPLIO"], true)).code) await must(["iptables", "-I", "FORWARD", "1", "-j", "EMPLIO"]);
  for (const to of ["169.254.0.0/16", "100.100.100.200/32"]) await rule("filter", "EMPLIO", ["-i", BRIDGE, "-d", to, "-j", "DROP"]);
  for (const port of ["25", "465", "587", "2525"]) await rule("filter", "EMPLIO", ["-i", BRIDGE, "-p", "tcp", "--dport", port, "-j", "REJECT"]);
  await rule("filter", "EMPLIO", ["-i", BRIDGE, "!", "-o", BRIDGE, "-j", "ACCEPT"]);
  await rule("filter", "EMPLIO", ["-o", BRIDGE, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"]);
  await rule("nat", "POSTROUTING", ["-s", "10.88.0.0/16", "!", "-o", BRIDGE, "-j", "MASQUERADE"]);
}

// The image, unpacked once per version into a folder every computer of that version shares (read-only to them).
async function image() {
  const version = (await must(["docker", "image", "inspect", "-f", "{{.Id}}", IMAGE])).replace("sha256:", "").slice(0, 12);
  const dir = join(BASE, "images", version);
  if (existsSync(join(dir, "ready"))) return version;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "rootfs"), { recursive: true });
  const made = await must(["docker", "create", IMAGE]);
  try {
    const d = await sh(["sh", "-c", `docker export ${made} | tar -x -C ${join(dir, "rootfs")}`]);
    if (d.code) throw new Error(`couldn't unpack the computer image: ${d.err.trim()}`);
  } finally {
    await sh(["docker", "rm", made], true);
  }
  writeFileSync(join(dir, "env.json"), await must(["docker", "image", "inspect", "-f", "{{json .Config.Env}}", IMAGE]));
  writeFileSync(join(dir, "ready"), "");
  return version;
}

function freeIp() {
  const used = new Set(all().map((m) => m.ip));
  for (let i = 2; i < 65_534; i++) {
    const ip = `10.88.${i >> 8}.${i & 255}`;
    if (!used.has(ip) && (i & 255) !== 255 && (i & 255) !== 0) return ip;
  }
  throw new Error("this server has no addresses left for computers");
}

// Its files (mounted again after a reboot), and its network: gVisor takes the address off the interface while it
// runs, so it's put back before every start or restore.
async function prepare(m: Meta) {
  const d = dirOf(m.id);
  const root = join(d, "rootfs");
  if ((await sh(["mountpoint", "-q", root], true)).code)
    await must(["mount", "-t", "overlay", "overlay", "-o", `lowerdir=${join(BASE, "images", m.image, "rootfs")},upperdir=${join(d, "upper")},workdir=${join(d, "work")}`, root]);
  const ns = `emp-${m.id}`;
  const veth = `ve${m.id.slice(0, 10)}`;
  if (!existsSync(`/var/run/netns/${ns}`)) await must(["ip", "netns", "add", ns]);
  if ((await sh(["ip", "link", "show", veth], true)).code) {
    await must(["ip", "link", "add", veth, "type", "veth", "peer", "name", "eth0", "netns", ns]);
    await must(["ip", "link", "set", veth, "master", BRIDGE, "up"]);
    await must(["bridge", "link", "set", "dev", veth, "isolated", "on"]);
  }
  await must(["ip", "-n", ns, "addr", "replace", `${m.ip}/16`, "dev", "eth0"]);
  await must(["ip", "-n", ns, "link", "set", "eth0", "up"]);
  await must(["ip", "-n", ns, "link", "set", "lo", "up"]);
  await must(["ip", "-n", ns, "route", "replace", "default", "via", GATEWAY]);
}

const CAPS = ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FSETID", "CAP_FOWNER", "CAP_MKNOD", "CAP_NET_RAW", "CAP_SETGID", "CAP_SETUID", "CAP_SETFCAP", "CAP_SETPCAP", "CAP_NET_BIND_SERVICE", "CAP_SYS_CHROOT", "CAP_KILL", "CAP_AUDIT_WRITE"];
function spec(m: Meta) {
  const env: string[] = JSON.parse(readFileSync(join(BASE, "images", m.image, "env.json"), "utf8"));
  return {
    ociVersion: "1.0.2",
    process: {
      terminal: false,
      user: USER,
      args: ["/usr/bin/tini", "--", "node", "/usr/local/lib/emplio-computer-helper.js"],
      env: [...env, "HOME=/home/user", `EMPLIO_HELPER_TOKEN=${m.token}`],
      cwd: "/home/user",
      // what sudo needs; the person's commands run without them until they use it, as in Docker
      capabilities: { bounding: CAPS, permitted: [], effective: [] },
      noNewPrivileges: false,
    },
    root: { path: join(dirOf(m.id), "rootfs"), readonly: false },
    hostname: m.id,
    mounts: [
      { destination: "/proc", type: "proc", source: "proc" },
      { destination: "/dev", type: "tmpfs", source: "tmpfs", options: ["nosuid", "strictatime", "mode=755", "size=65536k"] },
      { destination: "/dev/pts", type: "devpts", source: "devpts", options: ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"] },
      { destination: "/dev/shm", type: "tmpfs", source: "shm", options: ["nosuid", "noexec", "nodev", "mode=1777", "size=268435456"] },
      { destination: "/sys", type: "sysfs", source: "sysfs", options: ["nosuid", "noexec", "nodev", "ro"] },
    ],
    linux: {
      namespaces: [{ type: "pid" }, { type: "ipc" }, { type: "uts" }, { type: "mount" }, { type: "network", path: `/var/run/netns/emp-${m.id}` }],
      cgroupsPath: `/emplio/${m.id}`,
      resources: { memory: { limit: bytes(MEMORY), swap: bytes(MEMORY) }, cpu: { quota: CPUS * 100_000, period: 100_000 }, pids: { limit: 1024 } },
    },
  };
}

const status = async (id: string) => {
  const d = await sh([...RUNSC, "state", id], true);
  return d.code ? "gone" : (JSON.parse(d.out).status as string);
};
const saves = (id: string) => readdirSync(dirOf(id)).filter((f) => f.startsWith("saved-")).sort();

async function helper(m: Meta, path: string, init: RequestInit = {}) {
  return fetch(`http://${m.ip}:${HELPER}${path}`, { ...init, headers: { authorization: `Bearer ${m.token}` }, timeout: false } as RequestInit);
}
async function answering(m: Meta) {
  // usually well under a second; much longer when many start at once (a morning brief for everyone)
  for (const end = Date.now() + 60_000; Date.now() < end; ) {
    if (await helper(m, "/health", { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error("the computer started but doesn't answer");
}

// Running again: from its saved memory when there is one (everything comes back as it was), otherwise fresh
// (files kept, programs not). A save that won't restore is dropped for a fresh start.
async function start(m: Meta) {
  await prepare(m);
  await sh([...RUNSC, "delete", "-force", m.id], true);
  const saved = saves(m.id).at(-1);
  if (saved) {
    const d = await detached(m.id, [...RUNSC, "restore", "--detach", "--bundle", dirOf(m.id), "--image-path", join(dirOf(m.id), saved), m.id]);
    for (const s of saves(m.id)) rmSync(join(dirOf(m.id), s), { recursive: true, force: true });
    if (!d.code) return answering(m);
    console.error(`computer ${m.id}: couldn't restore its memory, starting it fresh: ${d.err.trim()}`);
    await sh([...RUNSC, "delete", "-force", m.id], true);
    await prepare(m);
  }
  const d = await detached(m.id, [...RUNSC, "run", "--detach", "--bundle", dirOf(m.id), m.id]);
  if (d.code) throw new Error(`the computer wouldn't start: ${d.err.trim()}`);
  await answering(m);
}

// Asleep: its memory saved to disk and the computer stopped, so it uses no memory or processor until it's needed.
async function sleep(m: Meta) {
  if ((await status(m.id)) !== "running") return;
  const path = join(dirOf(m.id), `saved-${Date.now()}`);
  const d = await sh([...RUNSC, "checkpoint", "--image-path", path, m.id], true);
  if (d.code) {
    console.error(`computer ${m.id}: couldn't save its memory, stopping it instead: ${d.err.trim()}`);
    rmSync(path, { recursive: true, force: true });
    await sh([...RUNSC, "kill", m.id, "KILL"], true);
  }
  await sh([...RUNSC, "delete", "-force", m.id], true);
  for (const s of saves(m.id).slice(0, -1)) rmSync(join(dirOf(m.id), s), { recursive: true, force: true });
  save({ ...m, slept: Date.now() });
}

const IDLE_MS = 5 * 60_000;
const sleepers = new Map<string, { timer: Timer; at: number }>();
function sleepAfter(id: string, ms: number, onlyLonger = false) {
  const at = Date.now() + ms;
  const was = sleepers.get(id);
  if (onlyLonger && was && was.at >= at) return;
  clearTimeout(was?.timer);
  const timer = setTimeout(() => {
    if (sleepers.get(id)?.timer !== timer) return;
    sleepers.delete(id);
    void serial(id, async () => {
      const m = metaOf(id);
      if (m) await sleep(m);
    }).catch((error) => console.error(`computer ${id}: sleeping failed`, error));
  }, ms);
  sleepers.set(id, { timer, at });
}

export async function create(labels: Record<string, string>, ms: number) {
  const version = await image();
  // address picked and claimed (saved) with nothing awaited in between, so computers made at once never share one
  const m: Meta = { id: randomBytes(6).toString("hex"), labels, ip: freeIp(), token: randomBytes(24).toString("hex"), image: version, created: Date.now() };
  const d = dirOf(m.id);
  for (const sub of ["upper", "work", "rootfs"]) mkdirSync(join(d, sub), { recursive: true });
  save(m);
  // written into its own layer, so they're there from the start and stay
  mkdirSync(join(d, "upper", "etc"), { recursive: true });
  writeFileSync(join(d, "upper", "etc", "resolv.conf"), DNS.map((ip) => `nameserver ${ip}\n`).join(""));
  writeFileSync(join(d, "upper", "etc", "hostname"), `${m.id}\n`);
  writeFileSync(join(d, "upper", "etc", "hosts"), `127.0.0.1 localhost\n${m.ip} ${m.id}\n`);
  writeFileSync(join(d, "config.json"), JSON.stringify(spec(m)));
  try {
    await serial(m.id, () => start(m));
  } catch (error) {
    await remove(m.id);
    throw error;
  }
  sleepAfter(m.id, ms);
  return m.id;
}

export const find = (id: string) => (/^[a-f0-9]{12}$/.test(id) ? metaOf(id) : null);

export async function list(labels: Record<string, string>) {
  const mine = all().filter((m) => Object.entries(labels).every(([k, v]) => m.labels[k] === v));
  return Promise.all(mine.map(async (m) => ({ id: m.id, labels: m.labels, asleep: (await status(m.id)) !== "running" })));
}

export function wake(m: Meta, ms: number, onlyLonger = false) {
  return serial(m.id, async () => {
    if ((await status(m.id)) !== "running") await start(m);
    sleepAfter(m.id, ms, onlyLonger);
  });
}

export async function keep(m: Meta, ms: number) {
  if ((await status(m.id)) !== "running") return false;
  sleepAfter(m.id, ms);
  return true;
}

export async function remove(id: string) {
  clearTimeout(sleepers.get(id)?.timer);
  sleepers.delete(id);
  await serial(id, async () => {
    await sh([...RUNSC, "kill", id, "KILL"], true);
    await sh([...RUNSC, "delete", "-force", id], true);
    await sh(["umount", join(dirOf(id), "rootfs")], true);
    await sh(["ip", "link", "del", `ve${id.slice(0, 10)}`], true);
    await sh(["ip", "netns", "del", `emp-${id}`], true);
    rmSync(dirOf(id), { recursive: true, force: true });
  });
}

const MEMORY_NOTE = `The computer ran out of memory (${MEMORY}): files are kept, programs that were running in it stopped. Use less memory at once (smaller batches, streaming instead of loading whole files).`;
// Over its memory, gVisor ends what runs in the computer (the files stay) and the helper's answer is cut off. If the
// computer doesn't come back answering by itself, it's started again fresh. Either way the agent is told.
async function outOfMemory(m: Meta) {
  for (let i = 0; i < 20; i++) {
    if (await helper(m, "/health", { signal: AbortSignal.timeout(500) }).then((r) => r.ok, () => false)) return;
    await Bun.sleep(100);
  }
  await serial(m.id, async () => {
    for (const s of saves(m.id)) rmSync(join(dirOf(m.id), s), { recursive: true, force: true });
    await sh([...RUNSC, "kill", m.id, "KILL"], true);
    await start(m);
  });
  sleepAfter(m.id, IDLE_MS, true);
}

export async function run(m: Meta, body: Record<string, unknown>, signal: AbortSignal) {
  const timeoutMs = Number(body.timeoutMs) || 60_000;
  const late = AbortSignal.timeout(timeoutMs + 20_000);
  await asleep(m);
  try {
    const r = await helper(m, "/run", { method: "POST", body: JSON.stringify(body), signal: AbortSignal.any([signal, late]) });
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  } catch (error) {
    if (signal.aborted) throw error;
    if (late.aborted) return Response.json({ exitCode: 124, result: `The computer didn't answer within ${Math.round(timeoutMs / 1000)}s` });
    await outOfMemory(m);
    return Response.json({ exitCode: 137, result: MEMORY_NOTE });
  }
}

// Not running at all (asleep, or the server restarted under it): woken with its saved memory first (a few ms to check).
async function asleep(m: Meta) {
  if ((await status(m.id)) === "running") return false;
  await wake(m, IDLE_MS, true);
  return true;
}

export async function file(m: Meta, method: string, path: string, body?: ArrayBuffer) {
  await asleep(m);
  const r = await helper(m, `/file?${new URLSearchParams({ path })}`, { method, body }).catch(async () => {
    await outOfMemory(m);
    return new Response(MEMORY_NOTE, { status: 500 });
  });
  return new Response(r.body, { status: r.status });
}

// Where a preview link goes. A sleeping computer is brought back first (its memory too, so what served the page
// is still there), and every visit keeps it awake 5 minutes more.
export async function previewTarget(id: string, port: string) {
  const m = find(id);
  if (!m) return null;
  await wake(m, 5 * 60_000, true);
  return `${m.ip}:${port}`;
}

// Asleep longer than this many days: deleted to free the disk (Emplio makes a fresh one if that person comes back).
export async function forgetOld(days: number) {
  for (const m of all()) if (m.slept && Date.now() - m.slept > days * 86_400_000 && (await status(m.id)) !== "running") await remove(m.id);
}

// After a restart of this program: timers for what's awake, and nothing half-done left behind.
export async function resume() {
  await ensureNetwork();
  // the image unpacked now rather than on the first computer (a minute or so for a new version)
  void image().catch((error) => console.error("unpacking the computer image failed", error));
  for (const m of all()) if ((await status(m.id)) === "running") sleepAfter(m.id, IDLE_MS);
  // the server shutting down (not just this program restarting): every awake computer saved, so a reboot loses nothing
  process.once("SIGTERM", async () => {
    if ((await sh(["systemctl", "is-system-running"], true)).out.trim() === "stopping")
      await Promise.all(all().map((m) => serial(m.id, () => sleep(m)).catch((error) => console.error(`computer ${m.id}: saving at shutdown failed`, error))));
    process.exit(0);
  });
}

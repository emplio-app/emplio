// Runs inside each computer when it's run by gVisor directly (runner/gvisor.ts): the runner asks it over the computer's
// network to run commands and read or write files. What it starts belongs to the computer itself, so a computer saved
// to disk while asleep comes back with it still running (a program started from outside it wouldn't).
// Only the runner knows the token; the computer's own programs could reach this port, but they can do all of it anyway.
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TOKEN = process.env.EMPLIO_HELPER_TOKEN;
delete process.env.EMPLIO_HELPER_TOKEN;
const MAX_OUTPUT = 20 * 1024 * 1024;

const body = (req) =>
  new Promise((ok, fail) => {
    const parts = [];
    req.on("data", (p) => parts.push(p)).on("end", () => ok(Buffer.concat(parts))).on("error", fail);
  });
const json = (res, status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));

function run(req, res, { command, cwd, env, timeoutMs }) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  // its own process group, so a timeout or a Stop ends everything it started in the foreground
  const p = spawn("bash", ["-c", command], { cwd: cwd || process.env.HOME, env: { ...process.env, ...env }, detached: true });
  const out = [];
  let size = 0;
  const keep = (b) => {
    if (size < MAX_OUTPUT) out.push(b.subarray(0, MAX_OUTPUT - size));
    size += b.length;
  };
  p.stdout.on("data", keep);
  p.stderr.on("data", keep);
  let timedOut = false;
  const kill = () => {
    try {
      process.kill(-p.pid, "SIGTERM");
      setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch {} }, 5000).unref();
    } catch {}
  };
  const timer = setTimeout(() => ((timedOut = true), kill()), seconds * 1000);
  res.on("close", () => !res.writableEnded && kill());
  let answered = false;
  const answer = (code) => {
    if (answered) return;
    answered = true;
    clearTimeout(timer);
    json(res, 200, timedOut ? { exitCode: 124, result: `Command timed out after ${seconds}s` } : { exitCode: code ?? 137, result: Buffer.concat(out).toString("utf8") });
  };
  p.on("error", (e) => keep(Buffer.from(String(e))) || answer(127));
  // a program left running in the background may hold the output open: a moment for the rest, then the answer
  p.on("exit", (code, signal) => setTimeout(() => answer(code ?? (signal ? 128 + require("node:os").constants.signals[signal] : 1)), 100));
  p.on("close", (code) => answer(code));
}

http
  .createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: "no" });
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/health") return json(res, 200, { ok: true });
      if (url.pathname === "/run" && req.method === "POST") return run(req, res, JSON.parse((await body(req)).toString() || "{}"));
      if (url.pathname === "/file") {
        const file = url.searchParams.get("path");
        if (!file) return json(res, 400, { error: "path needed" });
        if (req.method === "GET") {
          const s = fs.createReadStream(file);
          s.on("error", (e) => json(res, 404, { error: e.message })).on("open", () => (res.writeHead(200), s.pipe(res)));
          return;
        }
        if (req.method === "PUT") {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, await body(req));
          return json(res, 200, { ok: true });
        }
        if (req.method === "DELETE") {
          fs.rmSync(file, { recursive: true, force: true });
          return json(res, 200, { ok: true });
        }
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: String(e && e.message) });
    }
  })
  .listen(49983, "0.0.0.0");

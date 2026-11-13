// Local MCP servers (backend/src/mcp.ts is the other end): programs on this Mac that the server talks to. The server is
// the MCP client; this only starts the command, hands what it prints back line by line, and passes the server's
// messages in. A command it hasn't run before needs the person's OK here, remembered after that.
import { spawn } from "node:child_process";

export class LocalMcp {
  // ask(command) -> true to run it; allowed() -> commands already OK'd; remember(command); emit({ev, ...}); start = spawn, so a test can stand in
  constructor({ ask, allowed, remember, emit, start = spawn }) {
    Object.assign(this, { ask, allowed, remember, emit, start });
    this.running = new Map();
  }

  async open({ key, command }) {
    const fail = (e) => this.emit({ ev: "mcp.closed", key, e });
    if (typeof command !== "string" || !command.trim()) return fail("no command given");
    if (!this.allowed().includes(command)) {
      if (!(await this.ask(command))) return fail("the person said no on their Mac");
      this.remember(command);
    }
    // a login shell, so the PATH is the one in Terminal (brew's folder isn't on a Mac app's)
    const child = this.start(process.env.SHELL || "/bin/zsh", ["-lc", command], { stdio: ["pipe", "pipe", "pipe"] });
    this.running.set(key, child);
    let err = "";
    let out = "";
    child.stderr.on("data", (d) => (err = (err + d).slice(-500)));
    child.stdout.on("data", (d) => {
      out += d;
      let i;
      while ((i = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, i).trim();
        out = out.slice(i + 1);
        if (line) this.emit({ ev: "mcp.data", key, data: line });
      }
    });
    child.stdin.on("error", () => {});
    child.on("error", (e) => (this.running.delete(key), fail(e.message)));
    child.on("exit", (code) => this.running.get(key) === child && (this.running.delete(key), fail(err.trim() || `it stopped (exit ${code})`)));
  }

  send({ key, data }) {
    this.running.get(key)?.stdin.write(`${String(data).replace(/\n/g, " ")}\n`);
  }

  close({ key }) {
    const child = this.running.get(key);
    this.running.delete(key);
    child?.kill();
  }

  closeAll() {
    for (const key of [...this.running.keys()]) this.close({ key });
  }
}

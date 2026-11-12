// The agent's computer: a Docker container that wakes when it's needed and sleeps when idle. This server never
// touches Docker itself; it asks the runner (runner/runner.ts), which can do nothing but this.
export const COMPUTER_USD_PER_SECOND: number = 0;

export type RunOptions = { cwd: string; env?: Record<string, string>; timeoutMs: number; signal?: AbortSignal };
export type Box = {
  id: string;
  // the person's own computer, through the desktop app (devices.ts): nothing to meter, and a different system than the cloud's
  local?: boolean;
  // stdout and stderr interleaved as result; a timeout is exit code 124; signal kills it
  run(command: string, o: RunOptions): Promise<{ exitCode: number; result: string }>;
  write(path: string, bytes: Uint8Array | string): Promise<unknown>;
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  // sleeps this long after now; refuses (rejects) if it's already asleep
  keepAwake(ms: number): Promise<unknown>;
  kill(): Promise<unknown>;
};

const RUNNER = process.env.COMPUTER_RUNNER_URL ?? "http://runner:4100";

// timeout: false, because a long command is a long wait for this answer (Bun gives up after 5 minutes otherwise)
export async function runner(path: string, init: RequestInit = {}) {
  const r = await fetch(`${RUNNER}${path}`, {
    ...init,
    timeout: false,
    headers: { authorization: `Bearer ${process.env.RUNNER_TOKEN}`, ...(typeof init.body === "string" && { "content-type": "application/json" }) },
  } as RequestInit);
  if (!r.ok) throw new Error(`computer runner ${r.status}: ${await r.text()}`);
  return r;
}
const post = (path: string, body: unknown = {}, signal?: AbortSignal) => runner(path, { method: "POST", body: JSON.stringify(body), signal });
const fileAt = (id: string, path: string) => `/computers/${id}/file?${new URLSearchParams({ path })}`;

const boxOf = (id: string): Box => ({
  id,
  async run(command, { cwd, env, timeoutMs, signal }) {
    return (await post(`/computers/${id}/run`, { command, cwd, env, timeoutMs }, signal).then((r) => r.json())) as { exitCode: number; result: string };
  },
  write: (path, bytes) => runner(fileAt(id, path), { method: "PUT", body: typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes) }),
  read: async (path) => new Uint8Array(await (await runner(fileAt(id, path))).arrayBuffer()),
  readText: async (path) => (await runner(fileAt(id, path))).text(),
  remove: async (path) => void (await runner(fileAt(id, path), { method: "DELETE" })),
  keepAwake: (ms) => post(`/computers/${id}/keep`, { ms }),
  kill: () => runner(`/computers/${id}`, { method: "DELETE" }),
});

export type FoundBox = { id: string; labels: Record<string, string>; asleep: boolean };

export const findBoxes = async (labels: Record<string, string>) =>
  (await (await runner(`/computers?${new URLSearchParams({ labels: JSON.stringify(labels) })}`)).json()) as FoundBox[];

export async function wakeBox(id: string, idleMs: number) {
  await post(`/computers/${id}/wake`, { ms: idleMs });
  return boxOf(id);
}

export async function createBox(labels: Record<string, string>, idleMs: number) {
  const { id } = (await (await post("/computers", { labels, ms: idleMs })).json()) as { id: string };
  return boxOf(id);
}

// ponytail: no public preview links; add a proxy on this server if people need to open what the agent starts
export const previewNote = (name: string) =>
  `Previews: a server you start can only be reached from this computer, not by ${name}. Check it with \`curl -sI localhost:<port>\`, and to show ${name} the result send files or screenshots instead of a link. Servers stop when this computer goes to sleep, about 15 minutes after the last command.`;

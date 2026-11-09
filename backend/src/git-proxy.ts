// Plain `git` on Emplio's computer, with the person's login kept off it. Each command's git is told, in its
// environment only, to send github.com to /git/<token>/github.com/... here; this server adds the login and passes git's
// own traffic on. The token works only for that command, only through here. Nothing about git is left on the computer.
import type { ConnectCard } from "@emplio/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { record } from "./activity";
import { approve, mustAsk } from "./approvals";
import { appsCommand, gitLogins } from "./integrations";
import { AppsError } from "./integrations/types";
import type { Session } from "./sandbox";

// ponytail: GitHub only; another host is a line here plus an app with a login we hold (GitLab's user is "oauth2")
const HOSTS: Record<string, { app: string; name: string; logo: string; user: string }> = {
  "github.com": { app: "github", name: "GitHub", logo: "/logos/github.svg", user: "x-access-token" },
};

const SERVICES = new Set(["git-upload-pack", "git-receive-pack"]);
const SAFE = /^\w[\w.-]*$/;
// a background command outlives its reply: its git works this long
const LIVE_MS = 60 * 60_000;
// ponytail: a push is held in memory on its way through, so this is the biggest one; stream it if pushes get bigger
const MAX_BODY = 200 * 1024 * 1024;
const ALLOW_MS = 60 * 60_000;

type Push = { host: string; repo: string; refs: string[] };
type Command = {
  s: Session;
  // the login that worked, per repo and direction; null: none needed (public)
  logins: Map<string, string | null>;
  // repos nothing connected could reach, and whether anything was connected
  refused: Map<string, { host: string; repo: string; connected: boolean }>;
  // pushes waiting for the person's OK
  pushes: Map<string, Push>;
};

// ponytail: in memory; a server restart stops running commands anyway
const commands = new Map<string, Command>();
// pushes the person allowed, until they're made (one each)
const allowed = new Map<string, number>();
const allowKey = (s: Session, p: Push) => `${s.conversationId}|${p.host}/${p.repo}|${p.refs.join()}`;

// The branches a push changes: git's first lines, "<old> <new> <ref>", each behind a 4-digit hex length.
export function pushedRefs(body: Buffer) {
  const refs: string[] = [];
  for (let at = 0; at + 4 <= body.length; ) {
    const size = parseInt(body.toString("latin1", at, at + 4), 16);
    if (!size) break;
    const ref = body.toString("utf8", at + 4, at + size).split("\0")[0]!.trim().split(" ")[2];
    if (ref) refs.push(ref);
    at += size;
  }
  return refs;
}

// For one command: what its git needs in its environment, and the address to take back out of what it prints.
// Null on a server the computers can't reach (no public address): plain git then works as it would anyway.
export function gitForCommand(s: Session) {
  const base = process.env.WEBHOOK_URL ?? process.env.PUBLIC_API_URL;
  if (!base || /\/\/(localhost|127\.)/.test(base)) return null;
  const token = crypto.randomUUID();
  commands.set(token, { s, logins: new Map(), refused: new Map(), pushes: new Map() });
  setTimeout(() => commands.delete(token), LIVE_MS).unref();
  const proxy = `${base}/git/${token}/`;
  const rules = Object.keys(HOSTS).flatMap((h) => [`https://${h}/`, `git@${h}:`, `ssh://git@${h}/`].map((from) => [`${proxy}${h}/`, from] as const));
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: String(rules.length) };
  rules.forEach(([to, from], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = `url.${to}.insteadOf`;
    env[`GIT_CONFIG_VALUE_${i}`] = from;
  });
  return { token, proxy, env };
}

// After the command, with the computer free: what git couldn't do, for Emplio to read. A Connect button when nothing
// is connected, and the Allow card for a push (made by running the push again once it's allowed).
export async function gitAfter(token: string, s: Session) {
  const c = commands.get(token);
  commands.delete(token);
  const notes: string[] = [];
  const cards: ConnectCard[] = [];
  if (!c) return { notes, cards };
  for (const r of c.refused.values()) {
    const h = HOSTS[r.host]!;
    if (r.connected) notes.push(`git: no connected ${h.name} account can reach ${r.repo}. If another account owns it, connect that one (emplio apps add ${h.app}); otherwise check the name.`);
    else if (s.automation || s.thinker || s.task) notes.push(`git: ${r.repo} is private or doesn't exist, and no ${h.name} account is connected. Say in your last message that ${h.name} needs connecting.`);
    else {
      const reply = await appsCommand({ workspaceId: s.workspaceId, userId: s.user.id, role: s.role }, s.conversationId, ["add", h.app], async () => "");
      if (typeof reply === "string") notes.push(reply);
      else {
        notes.push(`git: ${r.repo} is private or doesn't exist, and no ${h.name} account is connected. ${reply.text}`);
        if ("path" in reply.card) cards.push(reply.card);
      }
    }
  }
  for (const p of c.pushes.values()) {
    const h = HOSTS[p.host]!;
    const key = allowKey(s, p);
    const allow = () => allowed.set(key, Date.now() + ALLOW_MS);
    const why = await approve(s, `${h.app}.git_push`, { repo: p.repo, refs: p.refs }, {
      own: {
        title: `Push to ${p.repo} (${p.refs.map((r) => r.replace(/^refs\/heads\//, "")).join(", ")})`,
        readOnly: false,
        appName: h.name,
        logo: h.logo,
        // allowed after the command gave up waiting: nothing is held to send, so it's pushed again
        run: async () => {
          allow();
          throw new AppsError("nothing has been pushed yet. Ask Emplio to push again");
        },
      },
    });
    if (why) notes.push(why);
    else {
      allow();
      notes.push(`git: ${s.user.name} allowed the push to ${p.repo}, but it hasn't happened yet. Run the same git push again now.`);
    }
  }
  return { notes, cards };
}

const relay = (reply: FastifyReply, r: Response) =>
  reply
    .code(r.status)
    .header("content-type", r.headers.get("content-type") ?? "application/octet-stream")
    .header("cache-control", "no-cache, max-age=0, must-revalidate")
    .send(r.body);

export async function gitProxyRoutes(app: FastifyInstance) {
  for (const type of ["application/x-git-upload-pack-request", "application/x-git-receive-pack-request"])
    app.addContentTypeParser(type, { parseAs: "buffer", bodyLimit: MAX_BODY }, (_req, body, done) => done(null, body));

  app.route<{ Params: { token: string; host: string; owner: string; repo: string; "*": string }; Querystring: { service?: string } }>({
    method: ["GET", "POST"],
    url: "/git/:token/:host/:owner/:repo/*",
    handler: async (req, reply) => {
      const { token, host, owner } = req.params;
      const rest = req.params["*"];
      const repo = req.params.repo.replace(/\.git$/, "");
      const c = commands.get(token);
      const h = Object.hasOwn(HOSTS, host) ? HOSTS[host] : undefined;
      const service = req.method === "GET" ? req.query.service : rest;
      // only git's three requests, only to the hosts above: this must never become a way to reach anything else
      const valid = req.method === "GET" ? rest === "info/refs" : SERVICES.has(rest);
      if (!c || !h || !SAFE.test(owner) || !SAFE.test(repo) || !valid || !service || !SERVICES.has(service)) return reply.code(404).type("text/plain").send("Not found");

      const path = `${owner}/${repo}`;
      const which = `${host}/${path}/${service}`;
      const headers: Record<string, string> = {};
      for (const name of ["accept", "content-type", "content-encoding", "git-protocol", "user-agent"]) {
        const value = req.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      const upstream = (auth: string | null, body?: Buffer) =>
        fetch(`https://${host}/${path}.git/${rest}${req.method === "GET" ? `?service=${service}` : ""}`, {
          method: req.method,
          headers: { ...headers, ...(auth && { authorization: auth }) },
          body: body as BodyInit | undefined,
        });
      const who = { workspaceId: c.s.workspaceId, userId: c.s.user.id, conversationId: c.s.conversationId };

      if (req.method === "GET") {
        const logins = await gitLogins(who, h.app);
        const tries: (typeof logins[number] & { auth: string | null } | { label: null; auth: null })[] = logins.map((l) => ({
          ...l,
          auth: `Basic ${Buffer.from(`${h.user}:${l.secret}`).toString("base64")}`,
        }));
        // anyone can read a public repo; nothing can be pushed without a login
        if (service === "git-upload-pack") tries.push({ label: null, auth: null });
        let last: Response | undefined;
        for (const t of tries) {
          const r = await upstream(t.auth);
          if (r.ok) {
            c.logins.set(which, t.auth);
            if (service === "git-upload-pack") record({ ...who, kind: "app", summary: `git fetch ${path}${t.label ? ` (${t.label})` : ""}` });
            return relay(reply, r);
          }
          void r.body?.cancel();
          last = r;
        }
        c.refused.set(path, { host, repo: path, connected: logins.length > 0 });
        return reply.code(last?.status ?? 401).type("text/plain").send("Not allowed");
      }

      const auth = c.logins.get(which);
      if (auth === undefined) return reply.code(401).type("text/plain").send("Not allowed");
      const body = req.body as Buffer;
      if (service === "git-receive-pack") {
        // no branches: git checking the way is clear before a big push, which changes nothing
        const refs = pushedRefs(body);
        if (refs.length) {
          const push = { host, repo: path, refs };
          const key = allowKey(c.s, push);
          const yes = (allowed.get(key) ?? 0) > Date.now();
          if (!yes && (await mustAsk(c.s, `${h.app}.git_push`))) {
            c.pushes.set(key, push);
            return reply.code(403).type("text/plain").send("This push needs the person's OK");
          }
          allowed.delete(key);
          record({ ...who, kind: "app", summary: `git push ${path} (${refs.join(", ")})` });
        }
      }
      return relay(reply, await upstream(auth, body));
    },
  });
}

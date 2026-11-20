// The page that links someone's WhatsApp: the sign-in a Connect button starts comes here (authorizeUrl), shows
// WhatsApp's QR code to scan from the phone (or a code to type, when this page is open on that phone), and once WhatsApp
// says it's linked, goes on to the usual sign-in callback with a code naming the account (linkedAccount).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { AppsError } from "../../types";
import { account, wa } from "./client";

const APP = "whatsapp_linked";
type Session = { account: string; at: number; codeAt?: number };
// sign-in → the WhatsApp server's account being linked for it
// ponytail: in memory; a restart mid-link means scanning a fresh code
const sessions = new Map<string, Session>();
const LINK_MS = 15 * 60_000;

const sig = (acct: string, state: string) => createHmac("sha256", process.env.ENCRYPTION_KEY!).update(`wa-link:${acct}:${state}`).digest("base64url");

// The account a finished link names, checked: only this sign-in's page could have made the code, and it's linked.
export async function linkedAccount(code: string, state: string) {
  const [acct = "", got = ""] = code.split(".");
  const want = sig(acct, state);
  if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw new AppsError("That WhatsApp link didn't finish. Try again.");
  const s = await wa("GET", `/accounts/${account(acct)}`);
  if (!s.linked) throw new AppsError("WhatsApp isn't linked yet. Try again.");
  return acct;
}

// The sign-in this page is for (signed by own/index.ts, not run out), and its account on the WhatsApp server.
async function session(state: string, create = true): Promise<Session | null> {
  const { own } = await import("../index");
  const s = own.readSignIn?.(APP, state);
  if (!s) return null;
  for (const [k, v] of sessions) if (Date.now() - v.at > LINK_MS) sessions.delete(k);
  let found = sessions.get(s.externalId);
  if (!found && create) {
    found = { account: (await wa("POST", "/accounts", {})).id, at: Date.now() };
    sessions.set(s.externalId, found);
  }
  return found ?? null;
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Link WhatsApp</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600&family=DM+Sans:opsz,wght@9..40,400;9..40,600&display=swap">
<style>body{font:15px/1.5 "DM Sans",system-ui,sans-serif;max-width:440px;margin:0 auto;padding:24px 16px;color:#111;background:#fff}h1{font:600 22px/1.2 "Bricolage Grotesque","DM Sans",system-ui,sans-serif;display:flex;gap:10px;align-items:center}h1 img{width:28px;height:28px}
ol{padding-left:20px}.m{color:#555;font-size:13px}.e{color:#c00}#qr{width:260px;height:260px;margin:12px auto;display:grid;place-items:center;background:#fff;border-radius:12px;border:1px solid #ddd}#qr svg{width:240px;height:240px}
#code{font:600 28px ui-monospace,monospace;letter-spacing:3px;text-align:center;margin:12px 0}.w{margin-top:16px;padding:10px 12px;border-radius:8px;background:#f5f5f4;border:1px solid #e7e5e4;font-size:13px;color:#57534e}
input{font:inherit;padding:10px;border:1px solid #ccc;border-radius:8px;width:100%;box-sizing:border-box}
button{font:inherit;margin-top:8px;width:100%;padding:11px;border:0;border-radius:8px;background:#111;color:#fff}a{color:inherit}details{margin-top:16px}summary{cursor:pointer}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}.w{background:#1c1c1c;border-color:#2a2a2a;color:#a8a29e}.m{color:#aaa}input{background:#1c1c1c;color:#eee;border-color:#333}button{background:#eee;color:#111}}</style>${body}`;

function linkPage(state: string, logo: string) {
  const s = JSON.stringify(state).replace(/</g, "\\u003c");
  return page(`<h1><img src="${esc(logo)}" alt="">Link your WhatsApp</h1>
<p>Emplio reads your chats and groups, and replies when you ask.</p>
<div id="risk"><p class="w">Don't use it for bulk or unwanted messages: WhatsApp bans numbers that spam. Linking other apps isn't officially supported by WhatsApp, so use it at your own risk.</p>
<button id="ok">I understand the risk</button></div>
<div id="link" hidden>
<div id="qr"><span class="m">Getting a code…</span></div>
<p>In WhatsApp: <b>Settings → Linked devices → Link a device</b>, then scan.</p>
<details id="byphone"><summary>On this phone? Use your number instead</summary>
<form id="f"><input id="phone" type="tel" placeholder="+1 555 123 4567" autocomplete="tel" required><button>Get a code</button></form>
<div id="pair" hidden><div id="code"></div><p>In <b>Link a device</b>, tap <b>Link with phone number instead</b> and type this code.</p></div>
<p class="e" id="err"></p></details>
<p class="m">Unlink any time in WhatsApp or Emplio.</p></div>
<script>
const state = ${s};
const qr = document.getElementById("qr");
async function poll() {
  try {
    const r = await fetch("link/status?state=" + encodeURIComponent(state));
    const d = await r.json();
    if (d.done) { location.href = d.done; return; }
    if (d.error) { qr.innerHTML = '<span class="e"></span>'; qr.firstChild.textContent = d.error; return; }
    if (d.qr) qr.innerHTML = d.qr;
    if (d.code) { document.getElementById("pair").hidden = false; document.getElementById("code").textContent = d.code; }
  } catch {}
  setTimeout(poll, 2000);
}
document.getElementById("ok").onclick = () => {
  document.getElementById("risk").hidden = true;
  document.getElementById("link").hidden = false;
  if (matchMedia("(pointer: coarse)").matches) document.getElementById("byphone").open = true;
  poll();
};
document.getElementById("f").onsubmit = async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  err.textContent = "";
  const b = e.target.querySelector("button");
  b.textContent = "Asking WhatsApp…";
  const r = await fetch("link/code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, phone: document.getElementById("phone").value }) });
  const d = await r.json().catch(() => ({}));
  b.textContent = "Get a code";
  if (!r.ok) { err.textContent = d.error || "That didn't work. Try again."; return; }
  document.getElementById("pair").hidden = false;
  document.getElementById("code").textContent = d.code;
};
</script>`);
}

// WhatsApp's pairing code, as it's typed: ABCD-EFGH
const spaced = (code: string | null) => (code && code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

export async function whatsappLinkRoutes(app: FastifyInstance) {
  const expired = page(`<p>This link has run out. Go back to Emplio and connect WhatsApp again.</p>`);

  app.get<{ Querystring: { state?: string } }>("/whatsapp/link", async (req, reply) => {
    const state = req.query.state ?? "";
    if (!(await import("../index")).own.readSignIn?.(APP, state)) return reply.type("text/html").send(expired);
    const logo = new URL("/logos/whatsapp_linked.svg", process.env.FRONTEND_URL ?? "http://localhost:3000").href;
    return reply.type("text/html").header("cache-control", "no-store").send(linkPage(state, logo));
  });

  app.get<{ Querystring: { state?: string } }>("/whatsapp/link/status", async (req, reply) => {
    const state = req.query.state ?? "";
    try {
      const s = await session(state);
      if (!s) return reply.code(410).send({ error: "This link has run out. Go back to Emplio and connect WhatsApp again." });
      const st = await wa("GET", `/accounts/${s.account}`);
      // relative to the page, so it works under a path prefix like /api on a self-hosted server
      if (st.linked) return { done: `../oauth/${APP}/callback?${new URLSearchParams({ code: `${s.account}.${sig(s.account, state)}`, state })}` };
      if (st.status === "unlinked") return { error: "WhatsApp turned the link down. Go back to Emplio and try again." };
      return { qr: st.qr, code: spaced(st.code) };
    } catch (error) {
      if (!(error instanceof AppsError)) throw error;
      return reply.code(503).send({ error: error.message });
    }
  });

  app.post<{ Body: { state?: string; phone?: string } }>(
    "/whatsapp/link/code",
    { schema: { body: { type: "object", properties: { state: { type: "string", maxLength: 4000 }, phone: { type: "string", maxLength: 40 } } } } },
    async (req, reply) => {
      const s = await session(req.body.state ?? "").catch(() => null);
      if (!s) return reply.code(410).send({ error: "This link has run out. Go back to Emplio and connect WhatsApp again." });
      const phone = (req.body.phone ?? "").replace(/\D/g, "").replace(/^00/, "");
      if (phone.length < 8) return reply.code(400).send({ error: "Write your number with the country code, like +1 555 123 4567." });
      // WhatsApp sends a notification to that phone each time: not more than one every half minute
      if (s.codeAt && Date.now() - s.codeAt < 30_000) return reply.code(429).send({ error: "Wait half a minute before asking for another code." });
      s.codeAt = Date.now();
      try {
        const st = await wa("POST", `/accounts/${s.account}/code`, { phone });
        return { code: spaced(st.code) };
      } catch (error) {
        if (!(error instanceof AppsError)) throw error;
        return reply.code(503).send({ error: error.message });
      }
    },
  );
}

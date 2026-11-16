// A link's page title, so a chat shows "Welcome to r/emplio" instead of "reddit.com/r/emplio/comments/1xq…"
// (GET /link-title?url=). The server fetches the page on behalf of the person, so it only ever goes to public
// addresses: every hop's host is looked up and refused if it points inside a network (this machine, the cloud's
// metadata address, a home router). Only the start of the page is read, and answers are remembered for a day.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";
import { context } from "./auth";
import { tooMany } from "./rate";

const HOPS = 4;
// the name most link previews send (iMessage does too): many sites, Reddit among them, only show titles to it
const UA = "Mozilla/5.0 (compatible; Emplio/1.0; +https://emplio.app) facebookexternalhit/1.1 Facebot Twitterbot/1.0";
// YouTube puts its title ~800 KB in; reading stops at </head> anyway
const MAX_BYTES = 1536 * 1024;
const DAY = 24 * 60 * 60_000;
// ponytail: plain Map with a size cap, drop oldest; move to Redis if several servers ever run
const CACHE_MAX = 5000;
const cache = new Map<string, { title: string | null; at: number }>();

// addresses inside a network, never fetched: loopback, private, link-local (cloud metadata), carrier NAT, multicast
export function isPrivate(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = ip.toLowerCase();
  // an IPv4 address dressed as IPv6, dotted (::ffff:127.0.0.1) or as URL parsing writes it (::ffff:7f00:1)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivate(mapped[1]!);
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
    return isPrivate(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("ff");
}

async function publicUrl(raw: string): Promise<URL | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || (u.port && u.port !== "80" && u.port !== "443")) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  // ponytail: checked at lookup, so a name that changes address between this check and the fetch (DNS rebinding)
  // could slip by; pin the address in the fetch if that ever matters
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  return ips.length && !ips.some(isPrivate) ? u : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
  );

// the page's own <title>, as the browser tab shows it; og:title only when there's none (Reddit's og:title on a post
// is a generic "From the emplio community on Reddit")
export function titleOf(html: string): string | null {
  const og =
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i.exec(html) ??
    /<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i.exec(html);
  const raw = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || og?.[1];
  const title = raw && decode(raw).replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 200) : null;
}

async function fetchTitle(raw: string): Promise<string | null> {
  let url = raw;
  for (let hop = 0; hop < HOPS; hop++) {
    const u = await publicUrl(url);
    if (!u) return null;
    const res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: { "user-agent": UA, accept: "text/html" },
    });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      await res.body?.cancel();
      url = new URL(next, u).href;
      continue;
    }
    if (!res.ok || !res.body || !/html/i.test(res.headers.get("content-type") ?? "")) {
      await res.body?.cancel();
      return null;
    }
    // read until </title> or the byte cap, never the whole page
    const reader = res.body.getReader();
    const text = new TextDecoder();
    let html = "";
    while (html.length < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += text.decode(value, { stream: true });
      if (/<\/title>/i.test(html) && /<\/head>|<body/i.test(html)) break;
    }
    await reader.cancel().catch(() => {});
    return titleOf(html);
  }
  return null;
}

export async function linkTitle(url: string): Promise<string | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < DAY) return hit.title;
  const title = await fetchTitle(url).catch(() => null);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(url, { title, at: Date.now() });
  return title;
}

export async function linkTitleRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { url?: string } }>("/link-title", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const url = req.query.url ?? "";
    if (url.length > 2000) return { title: null };
    if (!cache.has(url) && tooMany(`link-title:${ctx.userId}`, 120, 60_000)) return { title: null };
    return { title: await linkTitle(url) };
  });
}

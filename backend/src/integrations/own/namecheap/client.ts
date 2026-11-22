// Talking to Namecheap. Its API is one URL (api.namecheap.com/xml.response) taking a Command plus that command's
// fields as a form, and it answers in XML, failures included: a refused call is a 200 with Status="ERROR". Every
// call carries the API user, API key, username and the IP it comes from, and Namecheap only answers IPs the
// account has put on its API allow-list, so ClientIp is Emplio's server's public address.
import { z } from "zod";
import { AppsError } from "../../types";
import type { OwnAction } from "../index";

const URL_ = "https://api.namecheap.com/xml.response";
// The address Emplio's server calls from. Self-hosted servers set NAMECHEAP_CLIENT_IP to their own public IPv4.
// Unset, the help says "this server's public IP address" and Namecheap refuses calls with a message saying what to add.
export const clientIp = () => process.env.NAMECHEAP_CLIENT_IP || "";
export const ipText = () => clientIp() || "this Emplio server's public IP address (set NAMECHEAP_CLIENT_IP)";

// The key is "APIUSER:APIKEY", or "APIUSER:APIKEY:USERNAME" when the account acted on isn't the API user's own
export function parseKey(key: string) {
  const [apiUser = "", apiKey = "", userName] = key.split(":").map((s) => s.trim());
  if (!apiUser || !apiKey) throw new AppsError("enter your Namecheap username and API key");
  return { apiUser, apiKey, userName: userName || apiUser };
}

// ── XML to plain JSON. Namecheap's answers are small and regular (attributes, a few nested elements, short text),
// so a tiny reader does. ponytail: no DTDs or processing instructions beyond the <?xml?> header, which Namecheap never sends.
type Node = { tag: string; attrs: Record<string, string>; kids: Node[]; text: string };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l[0] === "#") return String.fromCodePoint(l[1] === "x" ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[l]!;
  });

export function parseXml(xml: string): Node {
  const root: Node = { tag: "#root", attrs: {}, kids: [], text: "" };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(re)) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      if (stack.length > 1) stack.pop();
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of m[4]!.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = decode(a[2] ?? a[3] ?? "");
      const node: Node = { tag: m[3], attrs, kids: [], text: "" };
      top.kids.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  return root;
}

const scalar = (s: string): unknown => (/^true$/i.test(s) ? true : /^false$/i.test(s) ? false : s);

// An element as JSON: attributes and child elements side by side, repeated children as arrays (always arrays for
// the tags in `lists`, so a list of one is still a list), text alone as a plain value or as `value` beside attributes.
export function toJson(n: Node, lists: string[] = []): unknown {
  const text = n.text.trim();
  if (!n.kids.length && !Object.keys(n.attrs).length) return lists.includes(n.tag) ? scalar(text) : text === "" ? null : scalar(text);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.attrs)) if (k !== "xmlns") out[k] = scalar(v);
  for (const k of n.kids) {
    const v = toJson(k, lists);
    if (k.tag in out) out[k.tag] = [out[k.tag]].flat().concat([v]);
    else out[k.tag] = lists.includes(k.tag) ? [v] : v;
  }
  if (text) out.value = scalar(text);
  return out;
}

const child = (n: Node | undefined, tag: string) => n?.kids.find((k) => k.tag.toLowerCase() === tag.toLowerCase());

// Account-level refusals: the key is wrong or API access is off (reconnect), or the call came from an IP not on the allow-list
const DEAD = new Set(["1011102", "1017101", "1010102", "1011101", "1017102"]);
const BAD_IP = new Set(["1011150", "1017150", "1017411"]);
export const ipHelp = () =>
  `Namecheap only answers from IP addresses on your allow-list: in Namecheap go to Profile → Tools → Namecheap API Access, make sure API access is ON, and under Whitelisted IPs add ${ipText()}`;

// One Namecheap command. Fields left undefined aren't sent; true/false go as "true"/"false", lists comma separated.
export async function nc(key: string, command: string, params: Record<string, unknown> = {}, lists: string[] = []): Promise<any> {
  const { apiUser, apiKey, userName } = parseKey(key);
  const form = new URLSearchParams({ ApiUser: apiUser, ApiKey: apiKey, UserName: userName, ClientIp: clientIp(), Command: command });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) form.set(k, Array.isArray(v) ? v.join(",") : String(v));
  const res = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  const body = await res.text();
  // 405 is how Namecheap says "too many calls" (20 a minute, 700 an hour, 8000 a day)
  if (res.status === 405) throw new AppsError("Namecheap: too many calls just now (it allows 20 a minute and 700 an hour); try again in a minute");
  const api = child(parseXml(body), "ApiResponse");
  if (!api) throw new AppsError(`Namecheap: unexpected answer (${res.status})${res.ok ? "" : `: ${body.slice(0, 200)}`}`);
  if (api.attrs.Status?.toUpperCase() !== "OK") {
    const errs = child(api, "Errors")?.kids ?? [];
    const why = errs.map((e) => `${e.text.trim()}${e.attrs.Number ? ` (${e.attrs.Number})` : ""}`).join("; ") || "the call failed";
    if (errs.some((e) => BAD_IP.has(e.attrs.Number ?? "")) || /\bIP\b/.test(why)) throw new AppsError(`Namecheap: ${why}. ${ipHelp()}`);
    if (errs.some((e) => DEAD.has(e.attrs.Number ?? "")))
      throw new AppsError(`Namecheap rejected the API key (${why}). Check API access is on and copy the key again from Profile → Tools → Namecheap API Access, then reconnect`, true);
    throw new AppsError(`Namecheap: ${why}`);
  }
  const out = (toJson(child(api, "CommandResponse") ?? { tag: "", attrs: {}, kids: [], text: "" }, lists) ?? {}) as Record<string, any>;
  delete out.Type;
  // a few commands answer Status="OK" with IsSuccess="false" (setHosts with an unknown EmailType): that's a failure too
  for (const v of Object.values(out)) if (v && typeof v === "object" && (v.IsSuccess === false || v.Success === false)) throw new AppsError(`Namecheap: ${command} did not go through (IsSuccess=false)`);
  const warnings = (child(api, "Warnings")?.kids ?? []).map((w) => w.text.trim()).filter(Boolean);
  return warnings.length ? { ...out, warnings } : out;
}

// ── building actions
type Opts = { readOnly?: boolean; lists?: string[]; params?: (i: Record<string, any>, key: string) => Record<string, unknown> };
export const cmd = (command: string, description: string, shape: z.ZodRawShape = {}, opts: Opts = {}): OwnAction => ({
  description,
  input: z.object(shape),
  readOnly: opts.readOnly ?? false,
  run: (i: Record<string, any>, key: string) => nc(key, command, opts.params ? opts.params(i, key) : i, opts.lists),
});

// SLD and TLD from a whole domain: example.co.uk → example, co.uk
export function split(domain: string) {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  const dot = d.indexOf(".");
  if (dot < 1) throw new AppsError(`${domain} isn't a domain name like example.com`);
  return { SLD: d.slice(0, dot), TLD: d.slice(dot + 1) };
}
// for commands that take SLD/TLD: the input's DomainName split into the two
export const sldTld = ({ DomainName, ...rest }: Record<string, any>) => ({ ...split(DomainName), ...rest });

// ── shared fields
export const domain = z.string().min(3).describe("The domain name, e.g. example.com (namecheap.list_domains)");
export const page = {
  Page: z.number().int().min(1).optional().describe("Which page of results (default 1)"),
  PageSize: z.number().int().min(10).max(100).optional().describe("How many per page, 10-100 (default 20)"),
};
export const years = (what: string, max = 10) => z.number().int().min(1).max(max).describe(`For how many years to ${what} (1-${max})`);
export const promo = z.string().optional().describe("A Namecheap coupon code, if you have one");
export const yesNo = (what: string) => z.enum(["yes", "no"]).optional().describe(what);
export const phone = (what: string) => z.string().describe(`${what}, written +countrycode.number, e.g. +91.9876543210 or +1.4155551234`);
export const country = z.string().length(2).describe("Two-letter country code, e.g. IN, US, GB");
// extra TLD-specific fields some endings need (.us nexus, .ca legal type, .eu…), sent as given
export const extra = z.record(z.string(), z.string()).optional().describe('Extra fields some domain endings require, as Namecheap names them, e.g. {"RegistrantNexus": "C11", "RegistrantPurpose": "P1"} for .us');

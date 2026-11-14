// Web search, on Exa (exa.ai). Two doors to the same client:
//  - `emplio web ...`: every chat can search and read the web on our key (EXA_API_KEY), nothing to connect;
//  - the "exa" app (integrations/own/exa.ts): a business connects its own Exa key and runs the full API
//    through `emplio apps run exa.<action>`, on its own account and limits.
// Platform searches are charged to the business asking (credit.ts) at what Exa says each call cost.
export class ExaError extends Error {
  constructor(message: string, readonly badKey = false) {
    super(message);
  }
}

export const CATEGORIES = ["company", "research paper", "news", "pdf", "github", "tweet", "personal site", "linkedin profile", "financial report"] as const;

export type SearchOptions = {
  query: string;
  numResults?: number;
  type?: "auto" | "fast" | "deep";
  category?: (typeof CATEGORIES)[number];
  includeDomains?: string[];
  excludeDomains?: string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
  // full page text (markdown) up to this many characters per result, instead of highlights only
  textCharacters?: number;
};
type Result = { id: string; url: string; title: string | null; publishedDate?: string | null; author?: string | null; highlights?: string[]; text?: string; summary?: string };

async function call<T>(key: string, path: string, body: object): Promise<T> {
  const res = await fetch(`https://api.exa.ai${path}`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(path === "/search" ? 120_000 : 60_000),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !data) throw new ExaError(data?.error ?? `Exa answered HTTP ${res.status}`, res.status === 401 || res.status === 403);
  return data;
}

const contents = (textCharacters?: number) =>
  textCharacters ? { text: { maxCharacters: textCharacters } } : { highlights: { numSentences: 3, highlightsPerUrl: 3 } };

export const search = (key: string, o: SearchOptions) =>
  call<{ results: Result[] }>(key, "/search", {
    query: o.query,
    numResults: o.numResults ?? 10,
    type: o.type ?? "auto",
    category: o.category,
    includeDomains: o.includeDomains?.length ? o.includeDomains : undefined,
    excludeDomains: o.excludeDomains?.length ? o.excludeDomains : undefined,
    startPublishedDate: o.startPublishedDate,
    endPublishedDate: o.endPublishedDate,
    contents: contents(o.textCharacters),
  });

export const similar = (key: string, url: string, numResults = 10, textCharacters?: number) =>
  call<{ results: Result[] }>(key, "/findSimilar", { url, numResults, excludeSourceDomain: true, contents: contents(textCharacters) });

// Pages as clean text (markdown); `fresh` fetches them now instead of from Exa's copy.
export const read = (key: string, urls: string[], maxCharacters = 50_000, fresh = false) =>
  call<{ results: Result[]; statuses?: { id: string; status: string; error?: { tag?: string } }[] }>(key, "/contents", {
    urls,
    text: { maxCharacters },
    livecrawl: fresh ? "always" : "fallback",
  });

export const answer = (key: string, query: string) =>
  call<{ answer: string; citations: { url: string; title: string | null }[] }>(key, "/answer", { query, text: false });

// --- `emplio web` ---

const day = (d?: string | null) => (d ? d.slice(0, 10) : "");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const short = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, "")}…`);

const listed = (results: Result[]) =>
  results.length
    ? results
        .map((r, i) =>
          [
            `${i + 1}. ${r.title ?? "(no title)"}${r.publishedDate ? ` (${day(r.publishedDate)})` : ""}`,
            `   ${r.url}`,
            // Exa's highlights can run to whole sections: two short passages per result
            ...(r.text ? [`   ${oneLine(r.text).slice(0, 1500)}`] : (r.highlights ?? []).slice(0, 2).map((h) => `   > ${short(oneLine(h), 300)}`)),
          ].join("\n"),
        )
        .join("\n\n")
    : "Nothing found. Try other words, a wider date range, or fewer filters.";

const USAGE = `usage: emplio web search <words> [options]          search the web; results with the passages that match
         --n <1-25>                 how many results (default 8)
         --fast | --deep            quicker, or slower and more thorough (default: balanced)
         --category <kind>          only ${CATEGORIES.join(", ")}
         --site <a.com,b.com>       only these sites     --not <a.com,...>   leave these out
         --since <YYYY-MM-DD>       published on or after   --until <YYYY-MM-DD>
         --full                     each result's page text (first 1,500 characters) instead of passages
       emplio web read <url>... [--fresh]                 pages as clean text
       emplio web similar <url> [--n <1-25>]              pages like this one (competitors, similar products)
       emplio web answer <question>                       a short answer from the web, with sources
For a business's own Exa account, use the exa app instead (emplio apps info exa).`;

// Flags out of the args: --n 5 → { n: "5" }; --full → { full: "" }.
function flags(args: string[]) {
  const words: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) words.push(a);
    else if (["full", "fast", "deep", "fresh"].includes(a.slice(2))) opts[a.slice(2)] = "";
    else opts[a.slice(2)] = args[++i] ?? "";
  }
  return { words, opts };
}

const count = (n?: string) => Math.min(25, Math.max(1, Number(n) || 8));
const domains = (s?: string) => s?.split(",").map((d) => d.trim()).filter(Boolean);

// The same `emplio web` asked again within 20 minutes gets the answer it got (and one asked while it's still running
// waits for that one) instead of paying Exa and the model's context for it twice. --fresh skips it.
// ponytail: in memory, last 500
const CACHE_MS = 20 * 60_000;
const recent = new Map<string, { at: number; answer: Promise<string> }>();
export function webCommand(args: string[], spend: (usd: number) => void, data = false) {
  if (args.includes("--fresh")) return askWeb(args, spend, data);
  const key = JSON.stringify([args, data]);
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.answer;
  const answer = askWeb(args, spend, data);
  recent.delete(key);
  recent.set(key, { at: Date.now(), answer });
  if (recent.size > 500) recent.delete(recent.keys().next().value!);
  // errors aren't kept: the next try asks again
  void answer.then((a) => a.startsWith("error:") && recent.get(key)?.answer === answer && recent.delete(key));
  return answer;
}

// `emplio web ...` from a chat, as text for the agent.
// Exa's own price for a call it answered
const paid = <T>(spend: (usd: number) => void, data: T) => (spend(Number((data as { costDollars?: { total?: number } }).costDollars?.total ?? 0)), data);

// asked by code (the Python library): each result as data
const asData = (results: Result[]) =>
  JSON.stringify(results.map((r) => ({ title: r.title ?? null, url: r.url, date: day(r.publishedDate) || null, text: r.text ?? (r.highlights ?? []).join(" … ") })));

async function askWeb(args: string[], spend: (usd: number) => void, data = false) {
  const key = process.env.EXA_API_KEY;
  if (!key) return "error: web search isn't set up on this server (EXA_API_KEY)";
  const [sub, ...rest] = args;
  const { words, opts } = flags(rest);
  try {
    switch (sub) {
      case "search": {
        if (!words.length) break;
        if (opts.category && !CATEGORIES.includes(opts.category as never)) return `error: --category is one of ${CATEGORIES.join(", ")}`;
        const { results } = paid(spend, await search(key, {
          query: words.join(" "),
          numResults: count(opts.n),
          type: "fast" in opts ? "fast" : "deep" in opts ? "deep" : "auto",
          category: opts.category as SearchOptions["category"],
          includeDomains: domains(opts.site),
          excludeDomains: domains(opts.not),
          startPublishedDate: opts.since,
          endPublishedDate: opts.until,
          textCharacters: "full" in opts ? 5000 : undefined,
        }));
        return data ? asData(results) : listed(results);
      }
      case "read": {
        if (!words.length) break;
        const { results, statuses } = paid(spend, await read(key, words.slice(0, 10), 100_000, "fresh" in opts));
        const failed = (statuses ?? []).filter((s) => s.status !== "success").map((s) => `${s.id}: couldn't read it (${s.error?.tag ?? s.status})`);
        // whole pages: a long result is saved and previewed like any long output (clip in sandbox.ts)
        const pages = results.map((r) => `# ${r.title ?? r.url}\n${r.url}${r.publishedDate ? ` · ${day(r.publishedDate)}` : ""}\n\n${r.text ?? ""}`);
        return [...pages, ...failed].join("\n\n---\n\n") || "Nothing came back.";
      }
      case "similar": {
        if (!words[0]) break;
        const { results } = paid(spend, await similar(key, words[0], count(opts.n)));
        return data ? asData(results) : listed(results);
      }
      case "answer": {
        if (!words.length) break;
        const a = paid(spend, await answer(key, words.join(" ")));
        return [a.answer, "", "Sources:", ...a.citations.map((c, i) => `[${i + 1}] ${c.title ?? c.url} ${c.url}`)].join("\n");
      }
    }
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  return USAGE;
}

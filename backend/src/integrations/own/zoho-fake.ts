// For the Zoho apps' tests: a fake fetch that answers by URL, remembering every call.
export type Sent = { url: string; path: string; query: URLSearchParams; method: string; headers: Record<string, string>; body: unknown };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const realFetch = globalThis.fetch;

export function fakeZoho(answer: (url: URL, method: string) => unknown | { $status: number; body: unknown }) {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const raw = init.body;
    const text = typeof raw === "string" ? raw : undefined;
    sent.push({ url: url.origin + url.pathname, path: url.pathname, query: url.searchParams, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: text?.startsWith("{") ? JSON.parse(text) : text });
    const out = answer(url, init.method ?? "GET") as { $status?: number; body?: unknown } | undefined;
    return out && typeof out === "object" && "$status" in out ? json(out.body, out.$status) : json(out ?? {});
  }) as typeof fetch;
  return sent;
}

export const zohoEnv = () => {
  process.env.ENCRYPTION_KEY ??= "test-key";
  process.env.ZOHO_CLIENT_ID = "zid";
  process.env.ZOHO_CLIENT_SECRET = "zsec";
  process.env.ZOHO_ACCOUNTS_URL = "https://accounts.zoho.com";
};
export const clearZohoEnv = () => {
  for (const v of ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_ACCOUNTS_URL"]) delete process.env[v];
  globalThis.fetch = realFetch;
};
export const BACK = "https://api.test/connections/abc/done?popup=1";

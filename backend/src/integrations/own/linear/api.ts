// Linear's one GraphQL endpoint, called with the person's API key (sent as is, no "Bearer").
import { AppsError } from "../../types";

const API = "https://api.linear.app/graphql";
export const KEY_HELP = "linear.app/settings/account/security";
type Gql = { message: string; extensions?: { code?: string; type?: string } };

// One GraphQL call. Linear answers errors with a 200 or a 400, and a dead key as an authentication error.
export async function gql(key: string, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => null)) as { data?: Record<string, unknown> | null; errors?: Gql[] } | null;
  const errors = body?.errors ?? [];
  const why = errors.map((e) => e.message).join("; ") || `${res.status} ${res.statusText}`;
  if (res.status === 401 || errors.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR" || /authenticat/i.test(e.extensions?.type ?? "")))
    throw new AppsError(`Linear rejected the API key; make a new one (${KEY_HELP}) and reconnect`, true, why);
  if (!body?.data) throw new AppsError(`Linear: ${why}`);
  return { data: body.data, errors: errors.map((e) => e.message) };
}


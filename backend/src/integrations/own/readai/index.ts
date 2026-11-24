import { AppsError } from "../../types";
import { mcpApp } from "../mcp-app";
import type { OwnApp } from "../index";

// Read AI (meeting notes for Zoom, Meet and Teams): meetings, summaries, action items, transcripts and folders, and
// sending its notetaker to a meeting, through Read AI's own MCP server. Read AI has no API keys; its REST API takes the
// same sign-in but only reads meetings, which the server's tools already cover. COVERAGE.md.
const base = mcpApp({ app: "readai", name: "Read AI", logo: "/logos/readai.svg", url: "https://api.read.ai/mcp" });

// The server has no "who am I" tool; the sign-in's own user info (OpenID) names the account.
export const readai: OwnApp & Pick<typeof base, "mcp"> = {
  ...base,
  async check(token) {
    const res = await fetch("https://authn.read.ai/userinfo", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (res?.status === 401) throw new AppsError("Read AI didn't accept the sign-in; connect it again", true);
    const me = (await res?.json().catch(() => null)) as { email?: string; name?: string } | null;
    return me?.email ?? me?.name ?? undefined;
  },
};

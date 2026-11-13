// The person's own Chrome, through the desktop app (devices.ts), standing in for the cloud's browser while their
// computer is connected. Same shape as browser-host.ts, so browser.ts treats them alike. The Chrome has its own folder
// of sign-ins on that computer (not their everyday Chrome), so a site signed in once stays signed in on later runs.
import { liveUrlOf } from "./browser-host";
import type { HostedBrowser } from "./browser-host";
import type { Owner } from "./browser";
import { cdpUrlOf, connected, deviceById, deviceFor, rpc } from "./devices";

export const BROWSER_KIND = "Chrome on the person's own computer, with their own sign-ins; they can watch it on their screen";
const ID = /^dev_([0-9a-f-]{36})_[a-z0-9]+$/;
export const isDeviceBrowser = (id: string) => id.startsWith("dev_");
const connOf = (id: string) => {
  const m = ID.exec(id);
  return m ? deviceById(m[1]!) : undefined;
};

type Started = { key: string; startedAt: string; timeoutAt: string };
const hosted = (deviceId: string, chat: string, b: Started): HostedBrowser => {
  const id = `dev_${deviceId}_${b.key}`;
  return { id, cdpUrl: cdpUrlOf(id), liveUrl: liveUrlOf(chat, b.timeoutAt, "device-live"), timeoutAt: b.timeoutAt, startedAt: b.startedAt };
};

export const deviceBrowser = {
  // sign-ins stay in that Chrome's own folder, so nothing is put back into it
  RESTORE_SIGN_INS: true as boolean, // the same saved sign-ins as the cloud browser
  BROWSER_KIND,
  // it is already on the person's own connection
  useProxy: async (_id: string, _owner: Owner) => false,

  async startHosted(chat: string, owner: Owner): Promise<HostedBrowser> {
    const conn = deviceFor(owner.userId, true);
    if (!conn) throw new Error("no computer connected");
    return hosted(conn.id, chat, await rpc<Started>(conn, "browser.start", { box: owner.workspaceId, name: "", chat }, { timeoutMs: 60_000 }));
  },

  // asked of every connected computer: the chat could be on any of them, and each only knows its own
  async listHosted(chat: string): Promise<HostedBrowser[]> {
    const lists = await Promise.all(
      connected().map((c) =>
        rpc<Started[]>(c, "browser.list", { chat }, { timeoutMs: 10_000 })
          .then((l) => l.map((b) => hosted(c.id, chat, b)))
          .catch(() => []),
      ),
    );
    return lists.flat();
  },

  async stopHosted(id: string) {
    const conn = connOf(id);
    if (conn) await rpc(conn, "browser.stop", { key: id.split("_")[2] }, { timeoutMs: 30_000 });
  },

  // downloads land straight in the computer's /work/tmp/downloads (the app sets that folder in Chrome), where sandbox.ts would have copied them
  hostedDownloads: async (_id: string): Promise<{ path: string; size: number; lastModified: string; url: string | null }[]> => [],
};

// The computer's own browser for this person if one is connected, else null (the cloud's browser is used).
export const deviceBrowserFor = (userId: string) => (deviceFor(userId, true) ? deviceBrowser : null);
export const browserKindFor = (userId: string, cloudKind: string) => (deviceFor(userId, true) ? BROWSER_KIND : cloudKind);

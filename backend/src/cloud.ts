// Where Emplio Cloud plugs in. The cloud/ folder, when a checkout has it, swaps in
// its own computer, browser, file storage, records database and billing, and adds its own routes and background
// work. A checkout without it runs the open parts below: Docker computers, Chromium, files on disk, SQLite files,
// nothing metered.
import type { FastifyInstance } from "fastify";
import * as browserHost from "./browser-host";
import * as computer from "./computer";
import * as credit from "./credit";
import * as storage from "./storage";

type Who = { workspaceId: string; userId: string; role: "owner" | "admin" | "member" };

export const cloud = {
  computer: computer as Pick<typeof computer, "COMPUTER_USD_PER_SECOND" | "findBoxes" | "wakeBox" | "createBox" | "previewNote">,
  browser: browserHost as Pick<
    typeof browserHost,
    "RESTORE_SIGN_INS" | "BROWSER_KIND" | "startHosted" | "useProxy" | "listHosted" | "stopHosted" | "hostedDownloads" | "browserHostRoutes"
  >,
  storage: storage as typeof storage,
  credit: {
    chargeQuietly: credit.chargeQuietly,
    pausedReason: credit.pausedReason,
    // background work held off by a pause (channels heldBack): tell whoever needs to know
    notePaused: async (_workspaceId: string, _reason: string) => {},
  },
  // each business's records database (database.ts): a local SQLite file unless `create` makes one elsewhere
  records: {
    // part of every database's name
    group: "dev",
    authToken: undefined as string | undefined,
    create: undefined as ((name: string) => Promise<string>) | undefined,
    // `emplio db restore <when>`: the reply to show
    restore: undefined as ((who: Who, when: string, conversationId: string | null) => Promise<string>) | undefined,
  },
  // a fixed sign-in code for this address instead of an emailed one, or null
  fixedCode: (_email: string): string | null => null,
  // a person just made a business (signing up, or "New business"): the cloud gives a first one its free trial
  onBusinessCreated: async (_workspaceId: string, _userId: string) => {},
  // a finished piece of work someone can use (a file made, an app action done, an agent's job done, a repeating task
  // set up): the cloud counts a business's first one
  onWork: (_workspaceId: string, _userId: string | null, _kind: "file" | "app" | "agent" | "automation") => {},
  // models a business may run: a Quality choice it's held to (with why, for Settings), or null for any
  models: {
    lock: async (_workspaceId: string): Promise<{ modelSet: string; why: string } | null> => null,
  },
  routes: [] as ((app: FastifyInstance) => Promise<void>)[],
  // started once the server is listening
  jobs: [] as (() => void)[],
};
export type Cloud = typeof cloud;

// The server's entry calls this first, before any route is registered.
export async function loadCloud() {
  const entry = new URL("../../cloud/backend/index.ts", import.meta.url).pathname;
  if (!(await Bun.file(entry).exists())) return false;
  const { plug } = (await import(entry)) as { plug: (c: Cloud) => void | Promise<void> };
  await plug(cloud);
  return true;
}

// What Docs and Sheets can do in Drive with the non-restricted drive.file scope: only files Emplio itself made there.
// The person's other Drive files are out of reach here, whatever they ask (docs and sheets by id still work through the Docs and Sheets APIs).
import { z } from "zod";
import { AppFile, AppsError } from "../types";
import { googleApi } from "./google-login";
import type { OwnAction } from "./index";
import { type Api, call, type Send } from "./openapi";

const API = googleApi("Google Drive", "https://www.googleapis.com");
// an upload is sent as the file's own type, or Drive stores everything as binary
const UPLOADS: Api = { ...API, upload: (file, _send, headers) => { headers["Content-Type"] = file.mimetype; } };
const FILES = "/drive/v3/files";
const META = "id,name,mimeType,createdTime,modifiedTime,trashedTime,trashed,parents,webViewLink,size";
export const ONLY_OURS = "Google only lets Emplio see files it made itself here, not everything in the person's Drive.";

const get = (path: string, ...query: string[]): Send => ({ method: "GET", path, query, headers: [] });
const send = (method: string, path: string, query: string[], ...fields: string[]): Send => ({ method, path, query, headers: [], body: { kind: "fields", fields: fields.map((f): [string, string] => [f, f]) } });
const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const fileId = z.string().describe("The file's id, the long part of its Google link");

// a file Drive won't show us is almost always one Emplio didn't make: say that rather than "not found"
const reachable = (a: OwnAction): OwnAction => ({
  ...a,
  run: (i, key) =>
    a.run(i, key).catch((e: unknown) => {
      if (e instanceof AppsError && /\(404\)$/.test(e.message)) throw new AppsError(`Drive can't find that file. ${ONLY_OURS} (${e.message})`);
      throw e;
    }),
});

export const searchFiles = (mimeType: string, what: string): OwnAction => ({
  description: `Search ${what} in Drive by name or content. ${ONLY_OURS}`,
  readOnly: true,
  input: z.object({
    name: z.string().optional().describe("Only files whose name contains this"),
    text: z.string().optional().describe("Only files containing this text"),
    mimeType: z.string().optional().describe(`The kind of file (default ${mimeType})`),
    trashed: z.boolean().default(false).describe("true looks in the trash instead"),
    modifiedAfter: z.string().optional().describe("Only files changed after this time, like 2026-01-31T00:00:00Z"),
    orderBy: z.string().default("modifiedTime desc").describe('Sort order, like "createdTime desc" or "name"'),
    pageSize: z.number().int().max(1000).default(100).describe("How many to return at once"),
    pageToken: z.string().optional().describe("From the last answer, for the next page"),
  }),
  run: (i, key) =>
    call(API, key, get(FILES, "q", "fields", "orderBy", "pageSize", "pageToken"), {
      ...i,
      fields: `nextPageToken,files(${META})`,
      q: [
        `mimeType = ${quote(i.mimeType ?? mimeType)}`,
        `trashed = ${i.trashed}`,
        i.name && `name contains ${quote(i.name)}`,
        i.text && `fullText contains ${quote(i.text)}`,
        i.modifiedAfter && `modifiedTime > ${quote(i.modifiedAfter)}`,
      ].filter(Boolean).join(" and "),
    }),
});

export const fileMetadata: OwnAction = reachable({
  description: `Get a Drive file's details: name, kind, folder, link, created and changed times. ${ONLY_OURS}`,
  readOnly: true,
  input: z.object({ fileId }),
  run: (i, key) => call(API, key, get(`${FILES}/{fileId}`, "fields"), { ...i, fields: META }),
});

export const filePermissions: OwnAction = reachable({
  description: `List who a Drive file is shared with and how. ${ONLY_OURS}`,
  readOnly: true,
  input: z.object({ fileId }),
  run: (i, key) => call(API, key, get(`${FILES}/{fileId}/permissions`, "fields"), { ...i, fields: "permissions(id,type,role,emailAddress,displayName)" }),
});

export const exportFile = (fixed?: { mimeType: string; extension: string }): OwnAction =>
  reachable({
    description: `Download a Google file as ${fixed ? fixed.extension.toUpperCase() : "another format (PDF, Word, Excel, CSV...)"}. ${ONLY_OURS}`,
    readOnly: true,
    input: z.object({ fileId, ...(fixed ? {} : { mimeType: z.string().describe("The format, like application/pdf or text/csv") }) }),
    async run(i, key) {
      const mimeType = fixed?.mimeType ?? i.mimeType;
      const f = await call(API, key, get(`${FILES}/{fileId}/export`, "mimeType"), { ...i, mimeType });
      return f instanceof AppFile ? new AppFile(`${i.fileId}.${fixed?.extension ?? mimeType.split("/").pop()}`, f.mimetype, f.bytes) : f;
    },
  });

export const copyFile: OwnAction = reachable({
  description: `Make a copy of a Drive file. ${ONLY_OURS}`,
  input: z.object({ fileId, name: z.string().optional().describe("The copy's name"), parents: z.array(z.string()).optional().describe("The folder to put it in (one Emplio made)") }),
  run: (i, key) => call(API, key, send("POST", `${FILES}/{fileId}/copy`, ["fields"], "name", "parents"), { ...i, fields: META }),
});

export const moveFile: OwnAction = reachable({
  description: `Move a file into a Drive folder. Both must be ones Emplio made. ${ONLY_OURS}`,
  input: z.object({ fileId, folderId: z.string().describe("The folder to move it to"), removeFrom: z.string().optional().describe("The folder it's leaving (default: stays in its old one as well)") }),
  run: (i, key) => call(API, key, send("PATCH", `${FILES}/{fileId}`, ["addParents", "removeParents", "fields"]), { fileId: i.fileId, addParents: i.folderId, removeParents: i.removeFrom, fields: META }),
});

export const createFile: OwnAction = {
  description: "Make an empty Drive file, folder or shortcut.",
  input: z.object({
    name: z.string().describe("Its name"),
    mimeType: z.string().default("application/vnd.google-apps.folder").describe("The kind of file (default: a folder)"),
    parents: z.array(z.string()).optional().describe("The folder to put it in (one Emplio made)"),
  }),
  run: (i, key) => call(API, key, send("POST", FILES, ["fields"], "name", "mimeType", "parents"), { ...i, fields: META }),
};

export const uploadFile: OwnAction = {
  description: "Upload a file from the computer to Drive. Up to 5 MB.",
  input: z.object({
    file: z.any().describe('The file: {"file": "/work/..."}'),
    name: z.string().optional().describe("Its name in Drive (default: the file's name)"),
    folderId: z.string().optional().describe("The folder to put it in (one Emplio made)"),
  }),
  async run(i, key) {
    if (!(i.file instanceof AppFile)) throw new AppsError('file: give the file as {"file": "/work/..."}');
    if (i.file.bytes.length > 5 * 1024 * 1024) throw new AppsError("file: over 5 MB");
    const made = (await call(UPLOADS, key, { ...get("/upload/drive/v3/files", "uploadType"), method: "POST", body: { kind: "file", field: "file" } }, { file: i.file, uploadType: "media" })) as { id: string };
    return call(API, key, send("PATCH", `${FILES}/{fileId}`, ["addParents", "fields"], "name"), { fileId: made.id, name: i.name ?? i.file.name, addParents: i.folderId, fields: META });
  },
};

export const listChanges: OwnAction = {
  description: `Start watching Drive for changes, or list what changed since. Give no pageToken first to get a starting token. ${ONLY_OURS}`,
  readOnly: true,
  input: z.object({ pageToken: z.string().optional().describe("The token from last time"), pageSize: z.number().int().max(1000).default(100) }),
  run: (i, key) =>
    i.pageToken
      ? call(API, key, get("/drive/v3/changes", "pageToken", "pageSize", "fields"), { ...i, fields: `nextPageToken,newStartPageToken,changes(fileId,removed,time,file(${META}))` })
      : call(API, key, get("/drive/v3/changes/startPageToken"), {}),
};

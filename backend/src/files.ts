import type { FileUIPart, UIMessage } from "ai";
import type { FastifyInstance } from "fastify";
import { context } from "./auth";
import type { Bill } from "./credit";
import { cloud } from "./cloud";
import sharp from "sharp";

// the bucket is shared with other products, so everything lives under our prefix

export const MAX_FILE_SIZE = 100 * 1024 * 1024;
// bigger ones the model doesn't read itself (its own limits); it opens them on its computer instead
export const MODEL_MAX = 20 * 1024 * 1024;
// Any file can be attached. The model reads images and PDFs itself and text-like files get inlined;
// everything else (Excel, PowerPoint, Word, zips, audio...) it opens on its computer, from /work/in.
const MODEL_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];
const TEXT_TYPES = ["text/plain", "text/markdown", "text/csv", "application/json"];

// where an attachment lands on the agent's computer (copyAttachments in sandbox.ts)
export const inName = (a: { url: string; filename?: string }) => (a.filename ?? a.url.split("/").pop() ?? "file").replaceAll("/", "_");

// Files are referenced by our own path, never by a bucket URL: /files/<workspaceId>/<fileId>/<name>
const FILE_PATH = /^\/files\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([^/]+)$/;
const keyOf = (path: string) => cloud.storage.keyPrefix + path.slice("/files/".length);

// Read one of our stored files by its /files/... path.
export const readStored = (path: string) => cloud.storage.readKey(keyOf(path));

export const storedSize = (path: string) => cloud.storage.sizeOfKey(keyOf(path));

export const removeStored = (path: string) => cloud.storage.removeKey(keyOf(path));

// A short-lived link to the bytes themselves; `download`: saved under its name instead of opened in the browser
export const storedLink = (path: string, download?: string) => cloud.storage.linkToKey(keyOf(path), download);

// Store bytes under the workspace and return the path the app serves them at.
export async function storeFile(workspaceId: string, name: string, type: string, body: Uint8Array) {
  const safeName = name.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "-").slice(-100) || "file";
  const path = `/files/${workspaceId}/${crypto.randomUUID()}/${safeName}`;
  await cloud.storage.writeKey(keyOf(path), body, type);
  return { url: path, mediaType: type, filename: name.slice(0, 200) };
}

export const isOwnFile = (url: string, workspaceId: string) => FILE_PATH.exec(url)?.[1] === workspaceId;

// Swap our file paths for something the model can use: images/PDFs inline as data URLs (a link fails
// wherever the model's host won't download from our storage), text inline as text.
// Photos go to the model at most 1200px on their long side (Anthropic shrinks past 1568 anyway): a phone photo is 12 megapixels, sent whole with every message it stays in. The stored file stays as it was.
export const MAX_SIDE = 1200;
export async function forModel(bytes: Uint8Array, mediaType: string) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(mediaType)) return bytes;
  try {
    const image = sharp(bytes);
    const { width = 0, height = 0 } = await image.metadata();
    if (Math.max(width, height) <= MAX_SIDE) return bytes;
    // rotate(): turned upright by its EXIF first, since the copy drops it
    return new Uint8Array(await image.rotate().resize(MAX_SIDE, MAX_SIDE, { fit: "inside" }).toBuffer());
  } catch {
    return bytes;
  }
}

export async function resolveFiles(history: UIMessage[]): Promise<UIMessage[]> {
  return Promise.all(
    history.map(async (m) => ({
      ...m,
      parts: await Promise.all(
        m.parts.map(async (p) => {
          if (p.type !== "file" || !FILE_PATH.test(p.url)) return p;
          if ((await storedSize(p.url).catch(() => 0)) > MODEL_MAX)
            return { type: "text" as const, text: `Attached file "${p.filename ?? "file"}" (${p.mediaType}, too big to read here): open it on your computer at /work/in/${inName(p)}` };
          if (TEXT_TYPES.includes(p.mediaType)) {
            const text = await readStored(p.url).then((bytes) => new TextDecoder().decode(bytes)).catch(() => "(file could not be read)");
            return { type: "text" as const, text: `Attached file "${p.filename ?? "file"}":\n\n${text}` };
          }
          if (!MODEL_TYPES.includes(p.mediaType))
            return { type: "text" as const, text: `Attached file "${p.filename ?? "file"}" (${p.mediaType}): open it on your computer at /work/in/${inName(p)}` };
          const bytes = await readStored(p.url).catch(() => null);
          if (!bytes) return { type: "text" as const, text: `Attached file "${p.filename ?? "file"}" (could not be read)` };
          return { ...p, url: `data:${p.mediaType};base64,${Buffer.from(await forModel(bytes, p.mediaType)).toString("base64")}` } satisfies FileUIPart;
        }),
      ),
    })),
  );
}

// Speech to text with Sarvam. Its quick endpoint takes ≤30s of audio, so a longer Ogg note (Telegram's voice
// notes) goes in pieces, and the texts are joined.
// Sarvam's ₹30 an hour (about $0.36), by the second, rounded up per request; charged to the business as AI work.
// seconds: the recording's length, from the channel or the browser that recorded it (capped at Sarvam's 30s a
// request; an Ogg note's own length wins, read from the file)
const SARVAM_USD_PER_SECOND = 0.36 / 3600;
export async function transcribe(bytes: Uint8Array, type: string, bill: Bill, seconds: number) {
  const pieces = type === "audio/ogg" ? oggPieces(bytes, 25) : [bytes];
  const heard = type === "audio/ogg" ? oggSeconds(bytes) : null;
  const billed = heard != null ? Math.ceil(heard) + pieces.length - 1 : Math.min(Math.ceil(seconds), 30 * pieces.length);
  cloud.credit.chargeQuietly(bill, "ai", Math.max(1, billed) * SARVAM_USD_PER_SECOND, `Voice note to text, ${Math.max(1, billed)}s`);
  const texts = await Promise.all(
    pieces.map(async (piece) => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(piece)], { type }), `voice.${type.split("/")[1]}`);
      form.append("model", "saaras:v4");
      const res = await fetch("https://api.sarvam.ai/speech-to-text", {
        method: "POST",
        headers: { "api-subscription-key": process.env.SARVAM_API_KEY ?? "" },
        body: form,
      });
      if (!res.ok) throw new Error(`Sarvam ${res.status}: ${await res.text()}`);
      return ((await res.json()) as { transcript: string }).transcript.trim();
    }),
  );
  return texts.join(" ").trim();
}

// An Ogg Opus file cut between pages into ~secs-long files: each is the header pages plus its audio pages.
// ponytail: a word can split at a cut, like the web recorder's pieces; Sarvam's batch API if that bites
// An Ogg Opus file's length: its last page's position, in 48kHz samples; null when it can't be read.
function oggSeconds(b: Uint8Array) {
  let last = -1n;
  for (let at = 0; at + 27 <= b.length && b[at] === 0x4f && b[at + 1] === 0x67; ) {
    const n = b[at + 26]!;
    let end = at + 27 + n;
    for (let i = 0; i < n; i++) end += b[at + 27 + i]!;
    const granule = new DataView(b.buffer, b.byteOffset + at + 6, 8).getBigInt64(0, true);
    if (granule > last) last = granule;
    at = end;
  }
  return last > 0n ? Number(last) / 48000 : null;
}

export function oggPieces(b: Uint8Array, secs: number) {
  const pages: { at: number; end: number; granule: bigint }[] = [];
  for (let at = 0; at + 27 <= b.length && b[at] === 0x4f && b[at + 1] === 0x67; ) {
    const n = b[at + 26]!;
    let end = at + 27 + n;
    for (let i = 0; i < n; i++) end += b[at + 27 + i]!;
    pages.push({ at, end, granule: new DataView(b.buffer, b.byteOffset + at + 6, 8).getBigInt64(0, true) });
    at = end;
  }
  const audio = pages.findIndex((p) => p.granule > 0n);
  if (audio < 1) return [b];
  const head = b.subarray(0, pages[audio]!.at);
  const out: Uint8Array[] = [];
  let from = audio;
  let start = 0n;
  pages.forEach((p, i) => {
    // Opus counts in 48kHz samples; -1 means no packet ends on this page
    if (i < audio || (i < pages.length - 1 && (p.granule < 0n || p.granule - start < BigInt(secs * 48000)))) return;
    out.push(Buffer.concat([head, b.subarray(pages[from]!.at, p.end)]));
    from = i + 1;
    start = p.granule;
  });
  return out;
}

export async function fileRoutes(app: FastifyInstance) {
  // Raw bytes in the body, real type/name in headers, so uploads never hit the JSON parser.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_FILE_SIZE }, (_req, body, done) =>
    done(null, body),
  );

  app.post("/uploads", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    // whatever the browser says, as long as it looks like a media type
    const given = String(req.headers["x-file-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(given) ? given : "application/octet-stream";
    const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "file"));
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: "Empty file" });

    return storeFile(ctx.workspaceId, name, type, body);
  });

  // Voice note in, text out. Sarvam's quick endpoint takes ≤30s, so the recorder sends long notes in pieces.
  app.post("/transcribe", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const type = String(req.headers["x-file-type"] ?? "audio/webm").split(";")[0]!;
    if (!type.startsWith("audio/")) return reply.code(415).send({ error: "Not an audio file" });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return reply.code(400).send({ error: "Empty recording" });
    try {
      const seconds = Number(req.headers["x-audio-seconds"]) || 30;
      return { text: await transcribe(req.body, type, { workspaceId: ctx.workspaceId, userId: ctx.userId }, seconds) };
    } catch (error) {
      req.log.error(error, "sarvam transcribe failed");
      return reply.code(502).send({ error: "Couldn't transcribe that, try again" });
    }
  });

  app.get<{ Params: { "*": string }; Querystring: { download?: string; raw?: string } }>("/files/*", async (req, reply) => {
    const ctx = await context(req, reply);
    if (!ctx) return;
    const path = `/files/${req.params["*"]}`;
    if (!isOwnFile(path, ctx.workspaceId)) return reply.code(404).send({ error: "Not found" });
    // ?raw: the bytes themselves, for the web app to read (the spreadsheet viewer); storage won't hand them to the page
    if (req.query.raw !== undefined)
      return reply.header("cache-control", "private, max-age=300").type("application/octet-stream").send(Buffer.from(await readStored(path)));
    // ponytail: redirect to a short-lived link; proxy the bytes if the bucket ever needs to stay invisible
    // ?download=<name>: under that name (a file renamed on the Files page), else the one it was stored under
    const name = req.query.download !== undefined ? req.query.download.slice(0, 200) || decodeURIComponent(path.split("/").pop()!) : undefined;
    return reply.header("cache-control", "private, max-age=300").redirect(storedLink(path, name));
  });
}

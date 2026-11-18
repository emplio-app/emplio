// `emplio image`: makes or edits a picture with the business's image model (Settings → Image model), on OpenRouter,
// on the business's own key when it gave one, else ours. The picture lands in /work/out/, so it's stored in Files
// like anything else Emplio makes. Charged to the business at what OpenRouter says the call cost.
import type { Settings } from "@emplio/shared";

export const IMAGE_USAGE = `usage: emplio image <what to draw> [--out <file.png>] [--from <image>]... [--ratio <w:h>]
         --out <file>       where to save it (default /work/out/image-<time>.png)
         --from <image>     a picture to start from or change (a logo, a product photo); several allowed
         --ratio <w:h>      shape: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 4:5, 5:4, 21:9 (default: the model's choice)
From Python: emplio.image("<description>", from_="/work/out/logo.png", ratio="4:5") (from_ with an underscore; a list for several).
Describe it fully: subject, style, colours, any words to show. A logo or photo that must appear goes in --from, never drawn
in code. It's shown to you and in the chat by itself.`;

const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9"];
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

type Reply = {
  choices?: { message?: { content?: string | null; images?: { image_url?: { url?: string } }[] } }[];
  usage?: { cost?: number };
  error?: { message?: string };
};

export async function imageCommand(
  settings: Pick<Settings, "imageModel" | "openrouterKey">,
  args: string[],
  io: { read: (path: string) => Promise<Uint8Array>; write: (path: string, bytes: Uint8Array) => Promise<void>; spend: (usd: number, model: string) => void; saved?: (path: string) => void },
  work = "/work",
) {
  const words: string[] = [];
  const from: string[] = [];
  let out = "";
  let ratio = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--out") out = args[++i] ?? "";
    else if (a === "--from") {
      // from Python, a list comes as JSON: from_=["a.png", "b.png"]
      const v = args[++i] ?? "";
      from.push(...(v.startsWith("[") ? (JSON.parse(v) as string[]) : [v]));
    } else if (a === "--ratio") ratio = args[++i] ?? "";
    // a misspelt option (frm=, source=) would otherwise end up as words in the description, and the picture never sent
    else if (a.startsWith("--")) return `error: no option ${a}. ${a.includes("fr") ? "A starting picture is --from (from_= in Python). " : ""}emplio image help`;
    else words.push(a);
  }
  const prompt = words.join(" ").trim();
  if (!prompt || prompt === "help") return IMAGE_USAGE;
  if (ratio && !RATIOS.includes(ratio)) return `error: --ratio is one of ${RATIOS.join(", ")}`;
  if (from.length > 4) return "error: at most 4 --from pictures";
  const key = settings.openrouterKey || process.env.OPENROUTER_API_KEY;
  if (!key) return "error: image making isn't set up on this server (OPENROUTER_API_KEY)";

  const pictures: string[] = [];
  for (const f of from) {
    const type = TYPES[f.split(".").pop()!.toLowerCase()];
    if (!type) return `error: ${f}: --from takes png, jpg, webp or gif`;
    const bytes = await io.read(f).catch(() => null);
    if (!bytes) return `error: ${f}: no such file`;
    pictures.push(`data:${type};base64,${Buffer.from(bytes).toString("base64")}`);
  }

  const model = settings.imageModel;
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "HTTP-Referer": "https://emplio.app", "X-Title": "Emplio" },
    body: JSON.stringify({
      model,
      modalities: ["image", "text"],
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...pictures.map((url) => ({ type: "image_url", image_url: { url } }))] }],
      ...(ratio && { image_config: { aspect_ratio: ratio } }),
      usage: { include: true },
      provider: { data_collection: "deny" },
    }),
    signal: AbortSignal.timeout(180_000),
  }).catch((e: Error) => e);
  if (res instanceof Error) return `error: the image model didn't answer (${res.message}). Try again.`;
  const data = (await res.json().catch(() => ({}))) as Reply;
  io.spend(Number(data.usage?.cost ?? 0), model);
  if (!res.ok) return `error: ${model}: ${data.error?.message ?? `HTTP ${res.status}`}`;
  const message = data.choices?.[0]?.message;
  const url = message?.images?.[0]?.image_url?.url ?? "";
  const m = url.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!m) return `error: ${model} made no picture${message?.content ? `: ${message.content.slice(0, 300)}` : ""}. Reword the description and try again.`;

  const ext = m[1] === "jpeg" ? "jpg" : m[1]!;
  // the name gets the real type's extension (a model may send jpg for a .png asked): emplio view refuses a mismatch
  const path = `${(out || `${work}/out/image-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`).replace(/\.(png|jpe?g|webp|gif)$/i, "")}.${ext}`;
  await io.write(path, Buffer.from(m[2]!, "base64"));
  io.saved?.(path);
  return `Saved ${path}${message?.content?.trim() ? `\nThe model said: ${message.content.trim().slice(0, 500)}` : ""}`;
}

// What a WhatsApp message says, as one line of text for the agent, and the ids of who it's from.
import { getContentType, jidNormalizedUser, normalizeMessageContent } from "baileys";
import type { WAMessage, proto } from "baileys";

// photos, videos, voice notes and files: the ones that can be downloaded later
export const MEDIA = new Set(["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage", "ptvMessage"]);

// A message's content as text: what was typed, or a label for what it is ("[voice note]") with any caption after it.
export function textOf(content: proto.IMessage | null | undefined): { type: string; text: string } | null {
  const m = normalizeMessageContent(content);
  const type = m && getContentType(m);
  if (!m || !type) return null;
  const c = (m as Record<string, any>)[type];
  const caption: string = m.conversation ?? c?.text ?? c?.caption ?? "";
  let label = "";
  if (type === "imageMessage") label = "[photo]";
  else if (type === "videoMessage" || type === "ptvMessage") label = "[video]";
  else if (type === "audioMessage") label = c?.ptt ? "[voice note]" : "[audio]";
  else if (type === "documentMessage") label = `[file: ${c?.fileName ?? "unnamed"}]`;
  else if (type === "stickerMessage") label = "[sticker]";
  else if (type === "locationMessage" || type === "liveLocationMessage")
    label = `[location: ${c?.degreesLatitude},${c?.degreesLongitude}${c?.name ? ` ${c.name}` : ""}${c?.address ? `, ${c.address}` : ""}]`;
  else if (type === "contactMessage") label = `[contact: ${c?.displayName ?? ""}]`;
  else if (type === "contactsArrayMessage") label = `[contacts: ${(c?.contacts ?? []).map((x: any) => x.displayName).join(", ")}]`;
  else if (type.startsWith("pollCreationMessage")) label = `[poll: ${c?.name ?? ""} (${(c?.options ?? []).map((o: any) => o.optionName).join(" / ")})]`;
  else if (type === "eventMessage") label = `[event: ${c?.name ?? ""}]`;
  else if (type === "conversation" || type === "extendedTextMessage") label = "";
  // protocol messages (deletes, edits), reactions, key exchanges and the like aren't something someone said
  else return null;
  const text = [label, caption].filter(Boolean).join(" ").trim();
  return text ? { type: type.replace(/Message$/, ""), text } : null;
}

// The message quoted in a reply, short.
export function quotedOf(content: proto.IMessage | null | undefined): string | null {
  const m = normalizeMessageContent(content);
  const type = m && getContentType(m);
  const quoted = type ? (m as Record<string, any>)[type]?.contextInfo?.quotedMessage : null;
  const t = quoted ? textOf(quoted)?.text : null;
  return t ? (t.length > 300 ? `${t.slice(0, 300)}…` : t) : null;
}

// Someone's id, by phone number where WhatsApp told us one: it shows hidden ids (@lid) for some people now, with the
// number alongside (alt), or learnt earlier (known).
export function canon(jid: string | null | undefined, alt?: string | null, known?: (lid: string) => string | null): string | null {
  if (!jid) return null;
  if (jid.endsWith("@lid")) {
    const pn = alt?.endsWith("@s.whatsapp.net") ? alt : known?.(jidNormalizedUser(jid));
    if (pn) return jidNormalizedUser(pn);
  }
  return jidNormalizedUser(jid);
}

export const phoneOf = (jid: string | null | undefined) => (jid?.endsWith("@s.whatsapp.net") ? `+${jid.split("@")[0]}` : null);

export const tsOf = (m: WAMessage) => Number(m.messageTimestamp?.toString() ?? 0) * 1000 || Date.now();

// Where a send goes, from what the agent wrote: an id, a phone number, or a chat's name.
export function targetOf(to: string): { jid: string } | { name: string } {
  const s = to.trim();
  if (s.includes("@")) return { jid: s };
  if (/^\+?[\d\s()-]{8,}$/.test(s)) return { jid: `${s.replace(/\D/g, "").replace(/^00/, "")}@s.whatsapp.net` };
  return { name: s };
}

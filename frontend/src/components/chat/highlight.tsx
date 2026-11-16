"use client";

import { useQuery } from "@tanstack/react-query";
import { LinkIcon, MailIcon, PhoneIcon } from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

// A web address as a short highlighted link: the page's title once the server has read it ("Welcome to r/emplio"),
// else the site and the start of the path, cut with … ("example.com/blog/how…"), as links to Emplio's own pages always are.
// The cut-off start (https://www.) is still there for copying, only not shown; hovering shows the whole address.
// The cap is in rem/vw, not %: a % cap is ignored when a sent-message bubble sizes itself, so it grew to the whole title.
export const URL_PATTERN = /(https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}])/;
export function ShortLink({ href, children, className }: { href: string; children?: ReactNode; className?: string }) {
  const lead = /^https?:\/\/(www\.)?/.exec(href)?.[0] ?? "";
  const { data: title } = useQuery({
    queryKey: ["link-title", href],
    queryFn: () => api<{ title: string | null }>(`/link-title?url=${encodeURIComponent(href)}`).then((r) => r.title),
    enabled: children === undefined && !!lead && !ownPath(href),
    staleTime: Infinity,
    retry: false,
  });
  return (
    <span title={href} className={cn("inline-flex max-w-[min(18rem,70vw)] items-baseline gap-1 rounded-sm bg-primary/10 px-1 align-bottom text-primary", className)}>
      {/* an email or phone number gets its own icon, so it doesn't read as a web link */}
      {(/^mailto:/i.test(href) ? <MailIcon aria-hidden className="size-3.5 shrink-0 self-center" /> : /^tel:/i.test(href) ? <PhoneIcon aria-hidden className="size-3.5 shrink-0 self-center" /> : <LinkIcon aria-hidden className="size-3.5 shrink-0 self-center" />)}
      <span className="truncate">
        {children ?? title ?? (
          <>
            <span className="sr-only">{lead}</span>
            {href.slice(lead.length)}
          </>
        )}
      </span>
    </span>
  );
}

// Emplio's own pages (emplio.app, the address this app is open on, or a path like /chat/...): the path to open inside
// the app, else null. Those open in the same tab with no outside-site question; other addresses are left as they are.
// On a computer at home or work, the app's own port on this machine or the local network counts too, so a
// localhost link works when the app is open on 192.168.x.x and the other way round.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)$/;
export function ownPath(href: string): string | null {
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    const u = new URL(href);
    const here = typeof window === "undefined" ? null : window.location;
    const own =
      /^(www\.)?emplio\.app$/.test(u.hostname) ||
      u.host === here?.host ||
      (!!here && u.port === here.port && LOCAL_HOST.test(u.hostname) && LOCAL_HOST.test(here.hostname));
    if ((u.protocol === "https:" || u.protocol === "http:") && own) return u.pathname + u.search + u.hash;
  } catch {}
  return null;
}

// the links in a piece of plain text: Emplio's own pages open in the app, other links in a new tab
function linked(text: string, key: number): ReactNode {
  const parts = text.split(new RegExp(URL_PATTERN.source, "g"));
  if (parts.length === 1) return text;
  return parts.map((p, i) => {
    if (!(i % 2)) return p;
    const inside = ownPath(p);
    return inside ? (
      <Link key={`${key}-${i}`} href={inside} className="hover:underline">
        <ShortLink href={p} />
      </Link>
    ) : (
      <a key={`${key}-${i}`} href={p} target="_blank" rel="noopener noreferrer" className="hover:underline">
        <ShortLink href={p} />
      </a>
    );
  });
}

// Text with some exact pieces marked: "/menu-cards" (a / command) and "@Priya Nair" (a mention).
// Only colour and background change, never size or weight, so the same text lines up exactly when it's
// drawn under the message box (HighlightLayer). A mark with an entry in `links` opens that page. `web`: web
// addresses become short links (a sent message; never the box's layer, where the text must line up).
export function Marked({ text, marks, links, className, web }: { text: string; marks: string[]; links?: Record<string, string>; className?: string; web?: boolean }): ReactNode {
  const pieces = [...new Set(marks.filter(Boolean))].sort((a, b) => b.length - a.length);
  const plain = (t: string, i: number) => (web ? linked(t, i) : t);
  if (!pieces.length) return plain(text, 0);
  const pattern = new RegExp(`(${pieces.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return text.split(pattern).map((piece, i) =>
    pieces.includes(piece) ? (
      <mark key={i} className={cn("rounded-sm bg-primary/15 text-primary", className)}>
        {links?.[piece] ? (
          <Link href={links[piece]} className="hover:underline">
            {piece}
          </Link>
        ) : (
          piece
        )}
      </mark>
    ) : (
      plain(piece, i)
    ),
  );
}

// Backspace right after a coloured /command or @mention takes the whole of it, not one letter.
export function eraseMark(e: KeyboardEvent<HTMLTextAreaElement>, text: string, marks: string[], setText: (t: string) => void) {
  const box = e.currentTarget;
  const at = box.selectionStart;
  if (e.key !== "Backspace" || e.defaultPrevented || at !== box.selectionEnd) return;
  const mark = marks
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find((m) => text.slice(at - m.length, at) === m);
  if (!mark) return;
  e.preventDefault();
  const start = at - mark.length;
  setText(text.slice(0, start) + text.slice(at));
  requestAnimationFrame(() => box.setSelectionRange(start, start));
}

// The message box's text drawn again underneath it with the marks coloured in, while the box's own text is
// transparent (the caret and selection stay the box's). Font, spacing and scroll are copied from the box
// itself, so it lines up whatever classes the box ends up with.
const COPIED = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "textIndent",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
] as const;

export function HighlightLayer({ text, marks }: { text: string; marks: string[] }) {
  const layer = useRef<HTMLDivElement>(null);
  const active = marks.some((m) => m && text.includes(m));
  useLayoutEffect(() => {
    const div = layer.current;
    const box = div?.parentElement?.querySelector("textarea");
    if (!div || !box) return;
    const sync = () => {
      const style = getComputedStyle(box);
      for (const k of COPIED) div.style[k] = style[k];
      div.style.borderStyle = "solid";
      div.style.borderColor = "transparent";
      div.scrollTop = box.scrollTop;
    };
    sync();
    // the box hides its own text only while there's something to colour, so plain typing is untouched
    box.classList.toggle("text-transparent", active);
    box.classList.toggle("caret-foreground", active);
    box.addEventListener("scroll", sync);
    const resized = new ResizeObserver(sync);
    resized.observe(box);
    return () => {
      box.removeEventListener("scroll", sync);
      resized.disconnect();
      box.classList.remove("text-transparent", "caret-foreground");
    };
  }, [active, text]);
  if (!active) return null;
  return (
    <div
      ref={layer}
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden break-words whitespace-pre-wrap text-foreground"
    >
      <Marked text={text} marks={marks} />
      {/* a last empty line still takes space, like in the box */}
      {"​"}
    </div>
  );
}

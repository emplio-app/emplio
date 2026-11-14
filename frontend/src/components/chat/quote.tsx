"use client";

// Replying to parts of replies: select text, press "Reply", and it goes with the next message as a Markdown
// quote ("> ...") with the answer to it underneath. One quote is answered in the message box, like any chat
// app; from two on, each quote gets its own answer box, so one message answers several points, each in
// place ("merge" under #112, "hold" under #115). The model reads it as quotes, each followed by its answer.
import { CornerDownRightIcon, XIcon } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import { Marked } from "@/components/chat/highlight";

export type Quote = { text: string; note: string };

const quoteBlock = (quote: string) =>
  quote
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

// the message: each quote, then its answer, then whatever was typed in the message box
export const withQuotes = (quotes: Quote[], text: string) =>
  [...quotes.flatMap((q) => [quoteBlock(q.text), q.note.trim()]), text.trim()].filter(Boolean).join("\n\n");

// a sent message in pieces: quotes (paragraphs whose every line starts with ">") and the text between them
export const quotePieces = (text: string) =>
  text.split(/\n{2,}/).reduce<{ quote: boolean; text: string }[]>((pieces, para) => {
    const quote = para.split("\n").every((l) => l.startsWith(">"));
    const clean = quote ? para.replace(/^> ?/gm, "") : para;
    const last = pieces.at(-1);
    if (last?.quote === quote) last.text += `\n\n${clean}`;
    else pieces.push({ quote, text: clean });
    return pieces;
  }, []);

// adds a quote, once
export const addQuote = (quotes: Quote[], text: string) => (quotes.some((q) => q.text === text) ? quotes : [...quotes, { text, note: "" }]);

const finger = () => matchMedia("(pointer: coarse)").matches;

// The "Reply" button over text selected in one of the AI's replies, inside `area`.
export function QuoteButton({ area, onQuote }: { area: RefObject<HTMLElement | null>; onQuote: (text: string) => void }) {
  // shown: off, it fades where it was, so the next selection's button glides over from there; glide: false while
  // the chat scrolls, so it stays on the text rather than trailing it
  const [at, setAt] = useState<{ text: string; x: number; y: number; above: boolean; shown: boolean; glide: boolean } | null>(null);
  useEffect(() => {
    const hide = () => setAt((a) => a && { ...a, shown: false });
    const place = (glide: boolean) => {
      const sel = window.getSelection();
      if (!sel?.rangeCount) return hide();
      const range = sel.getRangeAt(0).cloneRange();
      const elOf = (n: Node) => (n instanceof Element ? n : n.parentElement);
      // a triple-click, or a drag let go below the reply, ends the selection past it: keep the reply's part
      const msg = elOf(range.startContainer)?.closest(".is-assistant") ?? elOf(range.endContainer)?.closest(".is-assistant");
      if (!msg || !area.current?.contains(msg)) return hide();
      if (!msg.contains(range.startContainer)) range.setStart(msg, 0);
      if (!msg.contains(range.endContainer)) range.setEnd(msg, msg.childNodes.length);
      const text = range.toString().trim();
      if (!text) return hide();
      const rect = range.getBoundingClientRect();
      // scrolled out of the chat's view: hidden until it's back
      const view = area.current.getBoundingClientRect();
      if (rect.bottom < view.top || rect.top > view.bottom) return hide();
      if (!finger()) return setAt({ text, x: rect.left + rect.width / 2, y: rect.top - 8, above: true, shown: true, glide });
      // below the selection, the phone's own Copy menu being above it; on screen, and clear of the selection's handle
      const below = Math.min(rect.bottom + 20, window.innerHeight - 64);
      setAt({ text, x: Math.min(Math.max(rect.left + rect.width / 2, 56), window.innerWidth - 56), y: below, above: false, shown: true, glide });
    };
    const check = () => place(true);
    // A finger's selection has no release to listen for: once it has been still for a moment. The selection handles
    // can be dragged after that, and it follows.
    let settle: ReturnType<typeof setTimeout> | undefined;
    const settled = () => {
      clearTimeout(settle);
      settle = setTimeout(check, 300);
    };
    // on release, not while dragging; and gone once the selection is
    const clear = () => !window.getSelection()?.toString().trim() && hide();
    const changed = () => {
      clear();
      if (finger()) settled();
    };
    // it moves with the selection as the chat scrolls, once a frame. Any scroll on the page (captured: scroll doesn't
    // bubble), as the chat's own scroller can be swapped for another after this ran.
    let frame = 0;
    const follow = () => {
      if (frame || !window.getSelection()?.toString().trim()) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place(false);
      });
    };
    document.addEventListener("mouseup", check);
    document.addEventListener("keyup", check);
    document.addEventListener("selectionchange", changed);
    document.addEventListener("scroll", follow, true);
    return () => {
      clearTimeout(settle);
      cancelAnimationFrame(frame);
      document.removeEventListener("mouseup", check);
      document.removeEventListener("keyup", check);
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("scroll", follow, true);
    };
  }, [area]);
  if (!at) return null;
  const reply = () => {
    // cleared first: clearing it after would take the caret back out of the message box onQuote focuses
    window.getSelection()?.removeAllRanges();
    onQuote(at.text);
    setAt(null);
  };
  return (
    <button
      type="button"
      // keep the selection while pressing it
      onMouseDown={(e) => e.preventDefault()}
      // a finger's tap clears the selection, and with it this button, before its click arrives
      onPointerUp={(e) => {
        if (e.pointerType !== "mouse") {
          e.preventDefault();
          reply();
        }
      }}
      onClick={reply}
      style={{ left: at.x, top: at.y }}
      aria-hidden={!at.shown}
      tabIndex={at.shown ? undefined : -1}
      className={`fixed z-50 flex -translate-x-1/2 duration-150 ease-out animate-in fade-in motion-reduce:transition-none ${at.glide ? "transition-[left,top,opacity]" : "transition-opacity"} ${at.shown ? "" : "pointer-events-none opacity-0"} items-center gap-1.5 rounded-lg border bg-popover px-2.5 py-1.5 text-sm text-popover-foreground shadow-md select-none hover:bg-accent pointer-coarse:min-h-10 pointer-coarse:px-3.5 ${at.above ? "-translate-y-full" : ""}`}
    >
      <CornerDownRightIcon className="size-3.5" />
      Reply
    </button>
  );
}

// What's being replied to, above the message box. Two or more: each with its own answer box; Enter goes to
// the next one and on to the message box, which sends.
export function QuoteChips({ quotes, onChange }: { quotes: Quote[]; onChange: (quotes: Quote[]) => void }) {
  const many = quotes.length > 1;
  const focusAfter = (i: number) => {
    const next = document.querySelector<HTMLTextAreaElement>(`textarea[data-quote-note="${i + 1}"]`) ?? document.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    next?.focus();
  };
  return (
    <div className={`flex w-full flex-col px-3 pt-3 ${many ? "gap-2.5" : ""}`}>
      {quotes.map((q, i) => (
        <div key={q.text} className="animate-in fade-in slide-in-from-bottom-1 duration-150">
          <div className="flex items-start gap-2">
            <CornerDownRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <p className={`flex-1 text-sm text-muted-foreground ${many ? "line-clamp-1" : "line-clamp-2"}`}>{q.text}</p>
            <button
              type="button"
              onClick={() => onChange(quotes.filter((_, j) => j !== i))}
              aria-label="Remove quote"
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
          {many && (
            <textarea
              data-quote-note={i}
              rows={1}
              value={q.note}
              placeholder="Your reply to this"
              aria-label={`Your reply to quote ${i + 1}`}
              onChange={(e) => onChange(quotes.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                e.preventDefault();
                if (e.metaKey || e.ctrlKey) e.currentTarget.form?.requestSubmit();
                else focusAfter(i);
              }}
              className="mt-1 ml-5.5 block w-[calc(100%-1.375rem)] resize-none border-l-2 border-foreground/15 bg-transparent py-0.5 pl-2.5 text-[0.9rem] [field-sizing:content] outline-none placeholder:text-muted-foreground/50 focus:border-primary/60"
            />
          )}
        </div>
      ))}
      {!many && <p className="pl-5.5 text-xs text-muted-foreground/60">Select more and press Reply to answer several points, each on its own</p>}
    </div>
  );
}

// a sent message's quote, inside its bubble
export const QuoteInBubble = ({ quote }: { quote: string }) => (
  <span className="line-clamp-3 border-l-2 border-foreground/20 pl-2.5 text-sm text-muted-foreground">{quote}</span>
);

// a sent message: its quotes, each with the answer under it (spans: it sits inside LongText's <p>)
export const QuotedText = ({ text, marks, links }: { text: string; marks: string[]; links?: Record<string, string> }) => (
  <span className="flex flex-col gap-1.5">
    {quotePieces(text).map((p, i) =>
      p.quote ? <QuoteInBubble key={i} quote={p.text} /> : <span key={i} className="font-medium"><Marked text={p.text} marks={marks} links={links} className="font-medium" web /></span>,
    )}
  </span>
);

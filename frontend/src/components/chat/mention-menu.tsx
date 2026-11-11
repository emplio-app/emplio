"use client";

import { FUZZY, matchScore, NO_MATCH, type Mention, type MentionKind } from "@emplio/shared";
import { keepPreviousData, type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2Icon, ClipboardListIcon, FileTextIcon, MessageSquareIcon, TableIcon } from "lucide-react";
import { type KeyboardEvent, type SyntheticEvent, useEffect, useState } from "react";
import { AppLogo } from "@/components/chat/connect-card";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const GROUP: Record<MentionKind, string> = {
  person: "People",
  record: "Clients & suppliers",
  task: "Tasks",
  file: "Files",
  chat: "Chats",
  app: "Apps",
  table: "Tables",
};

// as the server orders them (backend/src/mentions.ts)
const ORDER: MentionKind[] = ["person", "app", "record", "task", "file", "chat", "table"];

// a name being typed after @ (at the start or after a space), up to the cursor; names have spaces, so up to 3 words
const TOKEN = /(?:^|\s)@([^\s@](?:[^@\n]{0,40})?)?$/;

// Everything any search so far brought back for one menu ("mentions" or "commands"), each once.
export function cached<T>(qc: QueryClient, menu: string, key: (t: T) => string) {
  const all = new Map<string, T>();
  for (const [, list] of qc.getQueriesData<T[]>({ queryKey: [menu] })) for (const t of list ?? []) all.set(key(t), t);
  return [...all.values()];
}

// What to show for what's typed, right away: the server's answer when it has come, otherwise the matches among
// what's already here (searched the way the server does), while the server looks through the rest.
export function instant<T>(
  qc: QueryClient,
  menu: string,
  query: string,
  o: { key: (t: T) => string; name: (t: T) => string; more: (t: T) => string; group: (t: T) => number; per: number; first?: (t: T) => boolean },
): { items: T[]; final: boolean } {
  const done = qc.getQueryData<T[]>([menu, query]);
  if (done) return { items: done, final: true };
  const q = query.trim().toLowerCase();
  const scored = cached(qc, menu, o.key)
    .map((t) => ({ t, s: matchScore(o.name(t), o.more(t), q) }))
    .filter((x) => x.s < NO_MATCH);
  // letters in order or a typo only count when nothing matches properly
  const proper = scored.filter((x) => x.s < FUZZY);
  const sorted = (proper.length ? proper : scored)
    .sort((a, b) => o.group(a.t) - o.group(b.t) || Number(!!o.first?.(b.t)) - Number(!!o.first?.(a.t)) || a.s - b.s || o.name(a.t).localeCompare(o.name(b.t)))
    .map((x) => x.t);
  const shown = new Map<number, number>();
  const items = sorted.filter((t) => {
    const n = shown.get(o.group(t)) ?? 0;
    shown.set(o.group(t), n + 1);
    return n < o.per;
  });
  return { items, final: false };
}

export function SearchingMore() {
  return <div className="px-2.5 py-1.5 text-xs text-muted-foreground">Searching for more…</div>;
}

// a few grey rows while the first results come
export function MenuSkeleton() {
  return (
    <div aria-busy className="absolute inset-x-0 bottom-full z-20 mb-2 rounded-xl border bg-popover p-1 shadow-md">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-2.5 px-2.5 py-2">
          <div className="size-7 shrink-0 animate-pulse rounded-md bg-muted" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-2.5 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

const mentionQuery = (q: string) => ({
  queryKey: ["mentions", q],
  queryFn: () => api<Mention[]>(`/mentions?q=${encodeURIComponent(q)}`),
  staleTime: 15_000,
});

export function MentionIcon({ m, className }: { m: Pick<Mention, "kind" | "label" | "logo">; className?: string }) {
  const box = cn("flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5", className);
  if (m.kind === "app") return <AppLogo src={m.logo} className={cn("size-7", className)} />;
  if (m.kind === "person")
    return <span className={cn(box, "rounded-full text-[0.65rem] font-medium")}>{m.label.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span>;
  const Icon = { record: Building2Icon, task: ClipboardListIcon, file: FileTextIcon, chat: MessageSquareIcon, table: TableIcon }[m.kind];
  return (
    <span className={box}>
      <Icon />
    </span>
  );
}

// Typing @ offers teammates, files, clients and suppliers, tasks, chats, connected apps and tables (searched on the
// server, backend/src/mentions.ts). A pick puts "@Name" in the text (coloured in) and links it; the linked ones still in the
// text go with the message, so the agent knows exactly who or what was meant.
export function useMentionMenu(input: string, setInput: (text: string) => void) {
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState<Mention[]>([]);
  const [active, setActive] = useState(0);
  const [closedFor, setClosedFor] = useState<string | null>(null);

  const before = input.slice(0, caret);
  const match = TOKEN.exec(before);
  const query = match ? (match[1] ?? "") : null;
  // a name already picked, then more words: that's the sentence going on, not a search
  const typing = query !== null && closedFor !== before && query.split(/\s+/).length <= 3 && !picked.some((p) => query.startsWith(p.label));

  // what a bare @ shows is fetched as the page opens, so it's there the moment @ is typed
  const queryClient = useQueryClient();
  useEffect(() => void queryClient.prefetchQuery(mentionQuery("")), [queryClient]);
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query ?? ""), 120);
    return () => clearTimeout(t);
  }, [query]);
  useQuery({ ...mentionQuery(debounced), enabled: typing, placeholderData: keepPreviousData });
  const found = instant<Mention>(queryClient, "mentions", query ?? "", {
    key: (m) => `${m.kind}:${m.id}`,
    name: (m) => m.label,
    more: (m) => m.detail ?? "",
    group: (m) => ORDER.indexOf(m.kind),
    per: 4,
  });
  const matches = typing ? found.items : [];
  const at = Math.min(active, Math.max(matches.length - 1, 0));

  const link = (m: Mention) => setPicked((p) => [...p.filter((x) => !(x.kind === m.kind && x.id === m.id)), m]);
  const pick = (m: Mention) => {
    const start = before.length - (query?.length ?? 0) - 1;
    const text = `${input.slice(0, start)}@${m.label} ${input.slice(caret)}`;
    const end = start + m.label.length + 2;
    setInput(text);
    link(m);
    setActive(0);
    setCaret(end);
    // after React puts the new text in, put the cursor after the name
    requestAnimationFrame(() => {
      const box = document.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
      box?.focus();
      box?.setSelectionRange(end, end);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!matches.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((at + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
    } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      pick(matches[at]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setClosedFor(before);
    }
  };
  const onSelect = (e: SyntheticEvent<HTMLTextAreaElement>) => setCaret(e.currentTarget.selectionStart);

  // the picked ones whose name is still in the text (deleting the name unlinks it)
  const linked = picked.filter((p) => input.includes(`@${p.label}`));

  const menu = matches.length ? (
    <div
      role="listbox"
      aria-label="Mention"
      className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-80 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {matches.map((m, i) => (
        <div key={`${m.kind}:${m.id}`}>
          {m.kind !== matches[i - 1]?.kind && (
            <div className="flex items-center justify-between px-2.5 pt-2 pb-1 text-[0.65rem] font-medium tracking-wide text-muted-foreground uppercase">
              {GROUP[m.kind]}
            </div>
          )}
          <button
            type="button"
            role="option"
            aria-selected={i === at}
            // keep the message box focused
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(m)}
            className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left", i === at && "bg-accent")}
          >
            <MentionIcon m={m} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{m.label}</span>
              {m.detail && <span className="block truncate text-xs text-muted-foreground">{m.detail}</span>}
            </span>
          </button>
        </div>
      ))}
      {!found.final && <SearchingMore />}
    </div>
  ) : typing && !found.final ? (
    <MenuSkeleton />
  ) : null;

  return { menu, linked, link, onKeyDown, onSelect, clear: () => setPicked([]) };
}

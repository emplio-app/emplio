"use client";

import { useQuery } from "@tanstack/react-query";
import type { RecordHit, SearchHit } from "@emplio/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

// Waits until typing pauses, so each keystroke doesn't search.
export function useDebounced<T>(value: T, ms = 250) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

// "the **invoice** for Acme" → text with the matches marked, starting a few words before the first one
// so it shows in the two lines there's room for
function Snippet({ text }: { text: string }) {
  const at = text.indexOf("**");
  const from = at > 30 ? text.lastIndexOf(" ", at - 25) + 1 : 0;
  return (
    <>
      {from > 0 && "…"}
      {text.slice(from).split("**").map((piece, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-sm bg-primary/15 px-0.5 text-foreground">
            {piece}
          </mark>
        ) : (
          piece
        ),
      )}
    </>
  );
}

const KIND: Record<RecordHit["kind"], string> = { client: "Client", contact: "Contact", project: "Project", service: "Service", meeting: "Meeting" };

// The clients, contacts, projects, services and meetings they may see, then chats whose title matches, then messages
// in this person's chats matching what's typed in the sidebar's search box.
export function SearchResults({ query, onOpen }: { query: string; onOpen: () => void }) {
  const q = useDebounced(query.trim());
  const hits = useQuery({
    queryKey: ["search", q],
    queryFn: () => api<SearchHit[]>(`/search?${new URLSearchParams({ q })}`),
    enabled: q.length >= 2,
  });
  const records = useQuery({
    queryKey: ["search-records", q],
    queryFn: () => api<RecordHit[]>(`/search/records?${new URLSearchParams({ q })}`),
    enabled: q.length >= 2,
  });

  if (q.length < 2 || hits.isPending || records.isPending)
    return <p className="px-4 py-6 text-sm text-muted-foreground">{q.length < 2 ? "Type to search clients, projects and your chats." : "Searching…"}</p>;
  if (!hits.data?.length && !records.data?.length)
    return <p className="px-4 py-6 text-sm text-muted-foreground">Nothing found for &quot;{q}&quot;.</p>;
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5 px-2 py-2">
      {records.data?.map((r) => (
        <li key={`${r.kind}/${r.slug}`}>
          <Link href={r.href} onClick={onOpen} className="block rounded-md px-2 py-2 hover:bg-sidebar-accent">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-sm font-medium">{r.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{KIND[r.kind]}</span>
            </div>
            {r.line && <p className="truncate text-xs text-muted-foreground">{r.line}</p>}
          </Link>
        </li>
      ))}
      {hits.data?.map((h) => (
        <li key={h.messageId || h.conversationId}>
          <Link
            href={`/chat/${h.conversationId}${h.messageId ? `#m-${h.messageId}` : ""}`}
            onClick={onOpen}
            className="block rounded-md px-2 py-2 hover:bg-sidebar-accent"
          >
            <div className="flex items-baseline gap-2">
              <span className="truncate text-sm font-medium">{h.title}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{day(h.createdAt)}</span>
            </div>
            {h.snippet && (
              <p className="line-clamp-2 text-xs break-words text-muted-foreground">
                <Snippet text={h.snippet.replace(/\s+/g, " ")} />
              </p>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

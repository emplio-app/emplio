"use client";

import type { KnowledgeFolder } from "@emplio/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon, ChevronRightIcon, FileTextIcon, FolderIcon, PencilIcon, SearchIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useDeferredValue, useEffect, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { MemoryTabs } from "@/components/knowledge/memory-tabs";

const KEY = ["knowledge"];
type Open = { repo: string; path: string };
const nameOf = (path: string) => path.split("/").pop()!.replace(/\.md$/, "");
const dirOf = (path: string) => path.split("/").slice(0, -1).join("/");
// where the AI employee finds the file on its computer
const agentPath = (o: Open) => `${o.repo.startsWith("me-") ? "me" : o.repo}/${o.path}`;

// A note's header block (--- key: value --- at the top, as skills have) as fields, and the text after it.
// ponytail: flat keys only; a nested or list value shows as its raw lines
export function splitNote(text: string) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fields: [], body: text };
  const fields: [string, string][] = [];
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([\w][\w -]*):\s*(.*)$/.exec(line);
    if (kv) fields.push([kv[1]!, kv[2]!]);
    else if (fields.length) fields[fields.length - 1]![1] += `\n${line.trim()}`;
  }
  const clean = (v: string) => v.trim().replace(/^[>|]-?\s*/, "").replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  return { fields: fields.map(([k, v]) => [k, clean(v)] as [string, string]), body: text.slice(m[0].length) };
}

// What the AI employee knows, as notes: the company's, restricted (owners and admins), and the person's own.
// Read here; changes go through the AI employee ("Suggest a change" opens a chat about the note), so they're
// made the way the rest of its files are, and staff changes to company notes become proposals.
export function KnowledgePage() {
  const router = useRouter();
  const folders = useQuery({ queryKey: KEY, queryFn: () => api<KnowledgeFolder[]>("/knowledge") });
  const [open, setOpen] = useState<Open | null>(null);
  const file = useQuery({
    queryKey: [...KEY, open?.repo, open?.path],
    queryFn: () => api<{ text: string }>(`/knowledge/file?${new URLSearchParams(open!)}`),
    enabled: !!open,
  });
  // /knowledge?file=company/x.md (an @mentioned note clicked in a chat): open it
  const asked = useSearchParams().get("file");
  useEffect(() => {
    const f = asked && folders.data?.find((f) => asked.startsWith(`${agentPath({ repo: f.repo, path: "" })}`));
    if (f) setOpen({ repo: f.repo, path: asked.slice(agentPath({ repo: f.repo, path: "" }).length) });
  }, [asked, folders.data]);
  const [q, setQ] = useState("");
  const words = useDeferredValue(q.trim());
  const found = useQuery({
    queryKey: [...KEY, "search", words],
    queryFn: () => api<{ repo: string; path: string; line: string }[]>(`/knowledge/search?${new URLSearchParams({ q: words })}`),
    enabled: !!words,
  });
  // notes whose name has the words first, then ones with them inside
  const named = words
    ? (folders.data ?? []).flatMap((f) => f.files.filter((p) => p.toLowerCase().includes(words.toLowerCase())).map((path) => ({ repo: f.repo, path, line: "" })))
    : [];
  const hits = [...named, ...(found.data ?? []).filter((h) => !named.some((n) => n.repo === h.repo && n.path === h.path))];
  const folder = folders.data?.find((f) => f.repo === open?.repo);
  const note = file.data && splitNote(file.data.text);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* the tabs stay put when a note opens; on a phone a note is its own screen, with the back arrow to return */}
      <header className={`flex h-14 shrink-0 items-center gap-2 border-b px-3 ${open ? "max-md:hidden" : ""}`}>
        <SidebarTrigger />
        <h1 className="sr-only">Memory</h1>
        <MemoryTabs />
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className={`under-tabs w-full shrink-0 overflow-y-auto border-r p-3 md:block md:w-64 ${open ? "hidden" : ""}`} aria-label="Notes">
          <div className="relative mb-3">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes" aria-label="Search notes" className="h-8 pl-8 text-sm" />
          </div>
          {folders.isPending && <Skeleton className="h-40 rounded-xl" />}
          {folders.error && <p className="p-2 text-sm text-destructive">{folders.error.message}</p>}
          {words ? (
            <div>
              {hits.map((h) => (
                <button
                  key={`${h.repo}/${h.path}`}
                  type="button"
                  onClick={() => setOpen({ repo: h.repo, path: h.path })}
                  aria-current={open?.repo === h.repo && open.path === h.path}
                  className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-accent/60 aria-[current=true]:bg-accent"
                >
                  <span className="flex items-center gap-2 text-sm">
                    <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{nameOf(h.path)}</span>
                  </span>
                  <span className="block truncate pl-5.5 text-xs text-muted-foreground">
                    {h.line || [folders.data?.find((f) => f.repo === h.repo)?.label, dirOf(h.path)].filter(Boolean).join(" / ")}
                  </span>
                </button>
              ))}
              {!hits.length && !found.isFetching && <p className="px-2 text-xs text-muted-foreground">Nothing matches.</p>}
            </div>
          ) : folders.data?.map((f) => (
            <section key={f.repo} className="mb-4">
              <div className="flex h-8 items-center px-2 text-xs font-medium text-muted-foreground">{f.label}</div>
              {f.files.length ? (
                <Tree paths={f.files} dir="" depth={0} open={open?.repo === f.repo ? open.path : null} onOpen={(path) => setOpen({ repo: f.repo, path })} />
              ) : (
                <p className="px-2 text-xs text-muted-foreground">No notes yet.</p>
              )}
            </section>
          ))}
        </nav>

        <main className={`under-tabs min-w-0 flex-1 overflow-y-auto ${open ? "" : "hidden md:block"}`}>
          {open && (
            <div className="material sticky top-0 z-10 flex h-14 items-center gap-2 border-b px-3 md:h-11">
              <Button size="icon" variant="ghost" className="size-8 md:hidden" aria-label="All notes" onClick={() => setOpen(null)}>
                <ChevronLeftIcon />
              </Button>
              <h2 className="min-w-0 truncate font-sans text-sm font-medium tracking-normal md:px-1">
                <span className="hidden text-muted-foreground md:inline">
                  {folder?.label} / {dirOf(open.path) && `${dirOf(open.path)} / `}
                </span>
                {nameOf(open.path)}
              </h2>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto shrink-0 gap-1.5"
                onClick={() => router.push(`/chat?file=${encodeURIComponent(agentPath(open))}`)}
              >
                <PencilIcon className="size-3.5" /> Suggest a change
              </Button>
            </div>
          )}
          {!open ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
              <FileTextIcon className="size-8 opacity-40" />
              Pick a note to read it.
            </div>
          ) : file.isPending ? (
            <Skeleton className="m-6 h-64 rounded-xl" />
          ) : file.error ? (
            <p className="p-6 text-sm text-destructive">{file.error.message}</p>
          ) : (
            <article className="mx-auto max-w-3xl px-6 py-6">
              {!!note!.fields.length && (
                <dl className="mb-6 grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-2 rounded-lg border bg-muted/40 p-4 text-sm">
                  {note!.fields.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="whitespace-pre-line">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <MessageResponse>{note!.body}</MessageResponse>
            </article>
          )}
        </main>
      </div>
    </div>
  );
}

// One folder's notes and, nested under it, its subfolders (closed until clicked).
function Tree({ paths, dir, depth, open, onOpen }: { paths: string[]; dir: string; depth: number; open: string | null; onOpen: (path: string) => void }) {
  const inside = (p: string) => !dir || p.startsWith(`${dir}/`);
  const rest = (p: string) => (dir ? p.slice(dir.length + 1) : p);
  const mine = paths.filter((p) => inside(p) && !rest(p).includes("/"));
  const subs = [...new Set(paths.filter((p) => inside(p) && rest(p).includes("/")).map((p) => rest(p).split("/")[0]!))].sort();
  const pad = { paddingLeft: `${0.5 + depth * 1}rem` };
  return (
    <>
      {subs.map((name) => {
        const sub = dir ? `${dir}/${name}` : name;
        return (
          <details key={sub} open={!!open?.startsWith(`${sub}/`) || undefined}>
            <summary style={pad} className="flex cursor-pointer list-none items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm hover:bg-accent/60 [&::-webkit-details-marker]:hidden">
              {/* its own folder's open state only: group-open would also turn every arrow nested inside an open folder */}
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform [details[open]>summary>&]:rotate-90" />
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{name}</span>
            </summary>
            <Tree paths={paths} dir={sub} depth={depth + 1} open={open} onOpen={onOpen} />
          </details>
        );
      })}
      {mine.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onOpen(p)}
          aria-current={open === p}
          style={{ paddingLeft: `${0.5 + depth * 1 + (depth ? 1.25 : 0)}rem` }}
          className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm ${open === p ? "bg-accent font-medium" : "hover:bg-accent/60"}`}
        >
          <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{nameOf(p)}</span>
        </button>
      ))}
    </>
  );
}

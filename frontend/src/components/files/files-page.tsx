"use client";

// Everything Emplio made and everything people attached, from any chat (backend made.ts), newest first; searched
// by name and by the words inside, and narrowed to one or the other. Opening one shows it in a panel beside the list, like the chat's; ?open=<id> (the link a phone chat gets) opens it straight away.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MadeFile } from "@emplio/shared";
import { ArrowUpIcon, DownloadIcon, FileDownIcon, FolderOpenIcon, MessageSquareIcon, MoreHorizontalIcon, PencilIcon, SearchIcon, Trash2Icon, UsersIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDeferredValue, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { fileHref } from "@/components/chat/attachments";
import { downloadHref, FilePanel, savePdf, FileTypeIcon, kindOf, madeQueryKey, type Shown } from "@/components/files/file-viewer";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { MemoryTabs } from "@/components/knowledge/memory-tabs";

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const shownOf = (f: MadeFile): Shown => ({ id: f.id, url: f.url, name: f.name, mediaType: f.mediaType });

type From = "all" | MadeFile["source"];
const EMPTY: Record<From, string> = {
  all: "Reports, quotes and sheets Emplio makes, and files you attach in any chat, show up here.",
  made: "Reports, quotes, sheets and pages Emplio makes in any chat show up here.",
  upload: "Files you attach in any chat show up here.",
};

export function FilesPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState("");
  const [from, setFrom] = useState<From>("all");
  const words = useDeferredValue(q.trim());
  const [opened, setOpened] = useState<Shown | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDialog, confirm] = useConfirm();

  const files = useQuery({
    queryKey: [...madeQueryKey, "list", words, from],
    queryFn: () => {
      const query = new URLSearchParams({ ...(words && { q: words }), ...(from !== "all" && { from }) }).toString();
      return api<MadeFile[]>(`/made${query ? `?${query}` : ""}`);
    },
    placeholderData: (prev) => prev,
  });
  // from a phone chat's link: that one file, open
  const openId = params.get("open");
  const linked = useQuery({ queryKey: [...madeQueryKey, openId], queryFn: () => api<MadeFile>(`/made/${openId}`), enabled: !!openId });
  const current = opened ?? (openId && linked.data ? shownOf(linked.data) : null);
  const close = () => {
    setOpened(null);
    if (openId) router.replace("/files");
  };

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api(`/made/${id}`, { name }, "PATCH"),
    onSettled: () => qc.invalidateQueries({ queryKey: madeQueryKey }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/made/${id}`, undefined, "DELETE"),
    onSettled: () => qc.invalidateQueries({ queryKey: madeQueryKey }),
  });
  // the owner and admins see everyone's: then say whose each one is
  const several = new Set(files.data?.map((f) => f.userName)).size > 1;

  return (
    <div className="flex min-h-0 flex-1">
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <h1 className="sr-only">Memory</h1>
        <MemoryTabs />
      </header>

      <div className="under-tabs min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-3xl grid-cols-1 gap-4 px-4 py-4 sm:py-6">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or what's inside" aria-label="Search files" className="h-10 pl-9" />
          </div>

          <Tabs value={from} onValueChange={(v) => setFrom(v as From)}>
            <TabsList aria-label="Show">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="made">By Emplio</TabsTrigger>
              <TabsTrigger value="upload">Uploaded</TabsTrigger>
            </TabsList>
          </Tabs>

          {files.isPending ? (
            <div className="grid gap-2">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : files.error ? (
            <p className="text-sm text-destructive">{files.error.message}</p>
          ) : !files.data?.length ? (
            <div className="grid justify-items-center gap-2 py-12 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-muted">
                <FolderOpenIcon className="size-5 text-muted-foreground" />
              </span>
              <p className="text-sm font-medium">{words ? "Nothing matches" : "No files yet"}</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                {words ? "Try other words." : EMPTY[from]}
              </p>
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-1">
              {files.data.map((f) => (
                <li key={f.id} className="group flex items-center gap-2 rounded-lg pr-1 hover:bg-muted/50">
                  {renaming === f.id ? (
                    <form
                      className="flex flex-1 items-center gap-3 p-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
                        if (name && name !== f.name) rename.mutate({ id: f.id, name });
                        setRenaming(null);
                      }}
                    >
                      <FileTypeIcon file={f} className="size-4 shrink-0 text-muted-foreground" />
                      <Input name="name" defaultValue={f.name} autoFocus aria-label="New name" className="h-8" onBlur={(e) => e.currentTarget.form?.requestSubmit()} />
                    </form>
                  ) : (
                    <button type="button" onClick={() => setOpened(shownOf(f))} className="flex min-w-0 flex-1 items-center gap-3 p-2 text-left">
                      {/* Emplio's in its colour; attached ones plain, with an upload mark */}
                      <span
                        className={`relative grid size-9 shrink-0 place-items-center rounded-md ${f.source === "upload" ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"}`}
                      >
                        {/* pictures as themselves, everything else as its type's icon */}
                        {kindOf(f) === "image" ? (
                          // ponytail: the full picture, lazily; a stored thumbnail if long lists get heavy
                          // eslint-disable-next-line @next/next/no-img-element -- our own stored file
                          <img src={fileHref(f.url)} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full rounded-md object-cover" />
                        ) : (
                          <FileTypeIcon file={f} className="size-4" />
                        )}
                        {f.source === "upload" && (
                          <span className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full border-2 border-background bg-foreground text-background">
                            <ArrowUpIcon className="size-2.5" strokeWidth={3} />
                          </span>
                        )}
                      </span>
                      <span className="grid min-w-0 gap-0.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">{f.name}</span>
                          {f.version > 1 && <span className="shrink-0 rounded bg-muted px-1 text-[0.65rem] text-muted-foreground">v{f.version}</span>}
                          {f.shareUrl && <UsersIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Shared" />}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {[
                            day(f.updatedAt),
                            size(f.size),
                            f.source === "upload" ? (several && f.userName ? `Uploaded by ${f.userName}` : "Uploaded") : several && f.userName,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </button>
                  )}
                  {f.conversationId && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="hidden shrink-0 sm:inline-flex"
                      title={f.conversationTitle ? `From "${f.conversationTitle}"` : "The chat it came from"}
                      aria-label="The chat it came from"
                      nativeButton={false}
                      render={<Link href={`/chat/${f.conversationId}`} />}
                    >
                      <MessageSquareIcon />
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="File options" className="shrink-0" />}>
                      <MoreHorizontalIcon />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44" finalFocus={false}>
                      {f.conversationId && (
                        <DropdownMenuItem onClick={() => router.push(`/chat/${f.conversationId}`)}>
                          <MessageSquareIcon /> Go to its chat
                        </DropdownMenuItem>
                      )}
                      {/* the server answers with the file as a download, so the page stays */}
                      <DropdownMenuItem onClick={() => (window.location.href = downloadHref({ url: f.url, name: f.name, mediaType: f.mediaType }))}>
                        <DownloadIcon /> Download
                      </DropdownMenuItem>
                      {/\.(md|txt)$/i.test(f.name) && (
                        <DropdownMenuItem onClick={() => void savePdf({ url: f.url, name: f.name, mediaType: f.mediaType })}>
                          <FileDownIcon /> Download as PDF
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => setRenaming(f.id)}>
                        <PencilIcon /> Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() =>
                          confirm({
                            title: "Delete this file?",
                            description: <>&ldquo;{f.name}&rdquo; will be deleted{f.shareUrl ? " and its share link will stop working" : ""}.</>,
                            onConfirm: () => remove.mutate(f.id),
                          })
                        }
                      >
                        <Trash2Icon /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {confirmDialog}
    </div>
    <FilePanel file={current} onClose={close} />
    </div>
  );
}

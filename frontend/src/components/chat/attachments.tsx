"use client";

import type { FileUIPart } from "ai";
import { FileTextIcon, RotateCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useOpenFile } from "@/components/files/file-viewer";
import { API_URL } from "@/lib/api";
import { cn, uuid } from "@/lib/utils";

// Any file can be attached (backend/src/files.ts decides who reads it: the model or its computer).
// Browsers leave `type` empty (or vendor-specific) for many text formats, so these fill it in from the extension.
const TYPES_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};
const MAX_SIZE = 100 * 1024 * 1024;
export const MAX_FILES = 10;

const typeOf = (file: File) =>
  TYPES_BY_EXT[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? (file.type || "application/octet-stream");

const formatSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// "XLSX", from the name; long vendor types (vnd.openxmlformats-...) don't fit
const kindOf = (name: string | undefined, mediaType: string) =>
  (name?.includes(".") ? name.split(".").pop()! : mediaType.split("/")[1]?.split(/[.+-]/).pop() ?? "file").toUpperCase();

// What a page of ours wants the next new chat to start with, and any files it uploaded for it (the welcome page).
// Kept in this tab, not the address: a link from anywhere could otherwise send a message as whoever opens it.
export const SAY_TEXT = "emplio-say-text";
export const SAY_FILES = "emplio-say-files";

export const fileHref = (url: string) => (url.startsWith("/") ? `${API_URL}${url}` : url);

type Attachment = {
  id: string;
  name: string;
  mediaType: string;
  size?: number;
  preview?: string; // local object URL, so images show instantly while uploading
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
  file?: File; // kept for retry; absent for attachments restored from a queued message
  part?: FileUIPart;
};

// fetch() can't report upload progress, XHR can
function upload(file: File, mediaType: string, onProgress: (fraction: number) => void) {
  const xhr = new XMLHttpRequest();
  const done = new Promise<FileUIPart>((resolve, reject) => {
    xhr.open("POST", `${API_URL}/uploads`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-file-type", mediaType);
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: { url?: string; mediaType?: string; filename?: string; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && body.url)
        resolve({ type: "file", url: body.url, mediaType: body.mediaType ?? mediaType, filename: body.filename });
      else reject(new Error(body.error ?? "Upload failed"));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}

const uploaded = (part: FileUIPart): Attachment => ({
  id: uuid(),
  name: part.filename ?? "file",
  mediaType: part.mediaType,
  progress: 1,
  status: "done",
  part,
});

export function useAttachments(kept: () => FileUIPart[] = () => []) {
  const [items, setItems] = useState<Attachment[]>(() => kept().map(uploaded));
  const aborts = useRef(new Map<string, () => void>());
  // only for the unmount cleanup below
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const patch = (id: string, change: Partial<Attachment>) =>
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, ...change } : a)));

  const start = (id: string, file: File, mediaType: string) => {
    const { done, abort } = upload(file, mediaType, (progress) => patch(id, { progress }));
    aborts.current.set(id, abort);
    done
      .then((part) => patch(id, { status: "done", progress: 1, part }))
      .catch((e: Error) => e.message !== "aborted" && patch(id, { status: "error", error: e.message }))
      .finally(() => aborts.current.delete(id));
  };

  const add = (files: File[]) => {
    const room = MAX_FILES - items.length;
    const next = files.slice(0, Math.max(0, room)).map((file): Attachment => {
      const mediaType = typeOf(file);
      const base = { id: uuid(), name: file.name, mediaType, size: file.size, file, progress: 0 };
      if (file.size > MAX_SIZE) return { ...base, status: "error", error: "Over 100 MB" };
      return {
        ...base,
        status: "uploading",
        preview: mediaType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      };
    });
    setItems((prev) => [...prev, ...next]);
    for (const a of next) if (a.status === "uploading") start(a.id, a.file!, a.mediaType);
  };

  const retry = (id: string) => {
    const a = items.find((x) => x.id === id);
    if (!a?.file || (a.size ?? 0) > MAX_SIZE) return;
    patch(id, { status: "uploading", progress: 0, error: undefined });
    start(id, a.file, a.mediaType);
  };

  const release = (a: Attachment) => {
    aborts.current.get(a.id)?.();
    if (a.preview) URL.revokeObjectURL(a.preview);
  };

  const remove = (id: string) => {
    const a = items.find((x) => x.id === id);
    if (a) release(a);
    setItems((prev) => prev.filter((x) => x.id !== id));
  };

  // hand the finished uploads to a message and empty the tray
  const take = () => {
    const parts = items.flatMap((a) => (a.part ? [a.part] : []));
    items.forEach(release);
    setItems([]);
    return parts;
  };

  // put already-uploaded files back in the tray (editing a queued message)
  const restore = (parts: FileUIPart[]) => setItems((prev) => [...prev, ...parts.map(uploaded)]);

  useEffect(() => () => itemsRef.current.forEach(release), []);

  return {
    items,
    add,
    remove,
    retry,
    take,
    restore,
    uploading: items.some((a) => a.status === "uploading"),
    ready: items.some((a) => a.status === "done"),
  };
}

export function AttachmentTray({
  items,
  onRemove,
  onRetry,
}: {
  items: Attachment[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="flex w-full flex-wrap gap-2 px-3 pt-3">
      {items.map((a) => {
        const image = a.mediaType.startsWith("image/") && (a.preview || a.part);
        return (
          <div
            key={a.id}
            className={cn(
              "group/chip relative flex h-14 items-center gap-2.5 overflow-hidden rounded-xl border bg-background animate-in fade-in zoom-in-95 duration-150",
              image ? "w-14" : "max-w-56 pr-3",
              a.status === "error" && "border-destructive/40",
            )}
            title={a.error ? `${a.name}: ${a.error}` : a.name}
          >
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element -- local blob / API redirect, not optimizable
              <img src={a.preview ?? fileHref(a.part!.url)} alt={a.name} className="size-full object-cover" />
            ) : (
              <>
                <div
                  className={cn(
                    "ml-2 flex size-10 shrink-0 items-center justify-center rounded-lg",
                    a.status === "error" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
                  )}
                >
                  {a.status === "error" ? <TriangleAlertIcon className="size-4" /> : <FileTextIcon className="size-4" />}
                </div>
                <div className="min-w-0 text-left">
                  <div className="truncate text-sm font-medium">{a.name}</div>
                  <div className={cn("text-xs", a.status === "error" ? "text-destructive" : "text-muted-foreground")}>
                    {a.status === "error"
                      ? a.error
                      : a.status === "uploading"
                        ? `Uploading… ${Math.round(a.progress * 100)}%`
                        : (a.size ? formatSize(a.size) : kindOf(a.name, a.mediaType))}
                  </div>
                </div>
              </>
            )}

            {a.status === "uploading" && (
              <div className="absolute inset-x-0 bottom-0 h-0.5 bg-foreground/10">
                <div className="h-full bg-foreground/60 transition-[width] duration-200" style={{ width: `${a.progress * 100}%` }} />
              </div>
            )}
            {image && a.status !== "done" && (
              <div
                className={cn(
                  "absolute inset-0 flex items-center justify-center",
                  a.status === "error" ? "bg-destructive/60 text-white" : "bg-background/40",
                )}
              >
                {a.status === "error" && <TriangleAlertIcon className="size-4" />}
              </div>
            )}

            <div className="absolute top-1 right-1 flex gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/chip:opacity-100 sm:focus-within:opacity-100">
              {a.status === "error" && a.file && a.error === "Upload failed" && (
                <ChipButton label={`Retry ${a.name}`} onClick={() => onRetry(a.id)}>
                  <RotateCwIcon className="size-3" />
                </ChipButton>
              )}
              <ChipButton label={`Remove ${a.name}`} onClick={() => onRemove(a.id)}>
                <XIcon className="size-3" />
              </ChipButton>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ChipButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-5 items-center justify-center rounded-full bg-foreground/80 text-background hover:bg-foreground"
    >
      {children}
    </button>
  );
}

// Attachments shown on a sent message: images as thumbnails, everything else as a file card; a tap opens it
// beside the chat (a new tab would be Safari in the iPhone app, not signed in).
export function MessageAttachments({ parts }: { parts: FileUIPart[] }) {
  const open = useOpenFile();
  if (!parts.length) return null;
  const show = (p: FileUIPart) => open?.({ url: p.url, name: p.filename ?? "File", mediaType: p.mediaType });
  return (
    <div className="ml-auto flex max-w-full flex-wrap items-start justify-end gap-2">
      {parts.map((p, i) =>
        p.mediaType.startsWith("image/") ? (
          <button key={i} type="button" onClick={() => show(p)} className="block overflow-hidden rounded-xl border" aria-label={`Open ${p.filename ?? "image"}`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- served via an authenticated redirect */}
            <img src={fileHref(p.url)} alt={p.filename ?? "image"} className="h-40 w-auto max-w-72 object-cover" />
          </button>
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => show(p)}
            className="flex max-w-64 items-center gap-2.5 rounded-xl border bg-card p-2 pr-3 text-left transition-colors hover:bg-muted"
          >
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <FileTextIcon className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{p.filename ?? "File"}</div>
              <div className="truncate text-xs text-muted-foreground">{kindOf(p.filename, p.mediaType)}</div>
            </div>
          </button>
        ),
      )}
    </div>
  );
}

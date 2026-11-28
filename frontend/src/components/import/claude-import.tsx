"use client";

import { CheckIcon, DownloadIcon, FileJsonIcon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Claude's export, in three moves. Its email brings a manifest: the list of the export's zips, each a link on
// claude.ai that only downloads where the person is signed in to Claude (so this browser opens it, not our
// server), and only for 24 hours and maybe once. So: drop the manifest, open each link we need (frames, design
// chats and metadata aren't), drop what downloaded; it's brought over as soon as all of it is here.

type Part = { filename: string; category: string; url: string };
const WANTED: Record<string, string> = { conversations: "Your chats", memories: "What Claude remembers", projects: "Your projects" };

async function readManifest(file: File): Promise<Part[]> {
  let j: { data_files?: { filename?: string; category?: string; export_url?: string }[] };
  try {
    j = JSON.parse(await file.text());
  } catch {
    throw new Error("That isn't Claude's manifest. It's the .json file from Claude's export email.");
  }
  const parts = (j.data_files ?? []).flatMap((f) =>
    // only Claude's own links get opened from here
    f.filename && f.category && f.export_url?.startsWith("https://claude.ai/") && f.category in WANTED
      ? [{ filename: f.filename, category: f.category, url: f.export_url }]
      : [],
  );
  if (!parts.length) throw new Error("That isn't Claude's manifest. It's the .json file from Claude's export email.");
  return parts;
}

// a browser saving the same file twice names it "conversations-000 (1).zip"
const baseName = (name: string) => name.replace(/ \(\d+\)(?=\.\w+$)/, "");

export function ClaudeImport({ busy, error, onFiles }: { busy: boolean; error?: string; onFiles: (files: File[]) => void }) {
  const [parts, setParts] = useState<Part[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [got, setGot] = useState<Map<string, File>>(new Map());
  const [dragging, setDragging] = useState(false);
  const manifestInput = useRef<HTMLInputElement>(null);
  const zipsInput = useRef<HTMLInputElement>(null);

  const takeManifest = (file?: File) =>
    file &&
    readManifest(file).then(
      (p) => (setProblem(null), setParts(p)),
      (e: Error) => setProblem(e.message),
    );

  const takeZips = (files: File[]) => {
    if (!parts) return;
    const next = new Map(got);
    for (const f of files) if (parts.some((p) => p.filename === baseName(f.name))) next.set(baseName(f.name), f);
    const extra = files.filter((f) => !parts.some((p) => p.filename === baseName(f.name)));
    setProblem(extra.length ? `Not needed: ${extra.map((f) => f.name).join(", ")}` : null);
    setGot(next);
    if (parts.every((p) => next.has(p.filename))) onFiles([...next.values()]);
  };

  const open = (p: Part) => {
    window.open(p.url, "_blank", "noopener");
    setOpened((s) => new Set(s).add(p.filename));
  };
  // one tab per press: browsers block a page opening several at once
  const nextUp = parts?.find((p) => !opened.has(p.filename) && !got.has(p.filename));

  const drop = (accept: (files: File[]) => void) => ({
    onDragOver: (e: React.DragEvent) => (e.preventDefault(), setDragging(true)),
    onDragLeave: () => setDragging(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      accept([...e.dataTransfer.files]);
    },
  });

  const zone = (on: boolean) =>
    cn(
      "flex w-full items-center gap-3 rounded-xl border border-dashed p-4 text-left text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
      on && "border-primary bg-primary/5",
    );

  return (
    <div className="grid gap-4">
      <Step n={1} done={!!parts} title="Ask Claude for your data">
        On claude.ai: Settings → Privacy → Export data. Claude emails you within a few minutes; download the manifest file from
        that email.
      </Step>

      <Step n={2} done={!!parts} title="Drop the manifest here">
        {!parts && (
          <>
            <input
              ref={manifestInput}
              type="file"
              hidden
              accept=".json,application/json"
              onChange={(e) => (takeManifest(e.target.files?.[0]), (e.target.value = ""))}
            />
            <button type="button" className={cn(zone(dragging), "mt-2")} onClick={() => manifestInput.current?.click()} {...drop((f) => takeManifest(f[0]))}>
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
                <FileJsonIcon className="size-4 text-muted-foreground" />
              </span>
              <span>
                <span className="block font-medium">Drop the manifest, or pick it</span>
                <span className="block text-xs text-muted-foreground">A .json file named manifest-…</span>
              </span>
            </button>
            <input
              ref={zipsInput}
              type="file"
              hidden
              multiple
              accept=".zip,.json"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                if (files.length) onFiles(files);
              }}
            />
            <Button variant="link" size="xs" disabled={busy} className="mt-2 h-auto p-0 text-muted-foreground" onClick={() => zipsInput.current?.click()}>
              {busy ? "Bringing it over…" : "Already downloaded the zips? Pick them instead"}
            </Button>
          </>
        )}
      </Step>

      {parts && (
        <Step n={3} done={parts.every((p) => got.has(p.filename))} title="Download these, then drop them here">
          <p className="text-xs text-muted-foreground">
            Each opens on claude.ai and downloads; you need to be signed in to Claude in this browser. The links last 24 hours.
          </p>
          <ul className="mt-3 divide-y rounded-xl border">
            {parts.map((p) => {
              const have = got.has(p.filename);
              return (
                <li key={p.filename} className="flex items-center gap-3 px-3 py-2.5">
                  <span
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded-full border",
                      have ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground",
                    )}
                  >
                    {have && <CheckIcon className="size-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{WANTED[p.category]}</span>
                    <span className="block truncate text-xs text-muted-foreground">{p.filename}</span>
                  </span>
                  {have ? (
                    <span className="text-xs font-medium text-primary">Here</span>
                  ) : (
                    <Button size="sm" variant={opened.has(p.filename) ? "ghost" : "outline"} onClick={() => open(p)}>
                      <DownloadIcon />
                      {opened.has(p.filename) ? "Again" : "Download"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {nextUp && (
            <Button className="mt-3" onClick={() => open(nextUp)}>
              <DownloadIcon />
              Download {parts.filter((p) => opened.has(p.filename) || got.has(p.filename)).length ? "the next one" : "the first one"}
            </Button>
          )}
          <input
            ref={zipsInput}
            type="file"
            hidden
            multiple
            accept=".zip,application/zip"
            onChange={(e) => (takeZips([...(e.target.files ?? [])]), (e.target.value = ""))}
          />
          <button type="button" disabled={busy} className={cn(zone(dragging), "mt-3")} onClick={() => zipsInput.current?.click()} {...drop(takeZips)}>
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
              <UploadIcon className="size-4 text-muted-foreground" />
            </span>
            <span>
              <span className="block font-medium">{busy ? "Bringing it over…" : "Drop the downloaded zips here"}</span>
              <span className="block text-xs text-muted-foreground">
                {busy ? "This takes a minute for a lot of chats." : `From your Downloads folder. ${got.size} of ${parts.length} here.`}
              </span>
            </span>
          </button>
          <Button variant="link" size="xs" className="mt-2 h-auto p-0 text-muted-foreground" onClick={() => (setParts(null), setGot(new Map()), setOpened(new Set()))}>
            Use a different manifest
          </Button>
        </Step>
      )}

      {(problem || error) && <p className="text-sm text-destructive">{error ?? problem}</p>}
    </div>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium",
          done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {done ? <CheckIcon className="size-3.5" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-0.5 text-sm text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

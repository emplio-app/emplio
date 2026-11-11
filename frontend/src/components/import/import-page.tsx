"use client";

import { IMPORT_SOURCES, type ImportResult, type ImportSource } from "@emplio/shared";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2Icon, CheckIcon, CopyIcon, FolderOpenIcon, UploadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ClaudeImport } from "@/components/import/claude-import";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { API_URL } from "@/lib/api";
import { copyText } from "@/lib/utils";

// Bringing what another AI knew about this person (backend imports.ts). The quick way, for any AI: they ask it
// the prompt below and paste its answer, saved as one note. Old chats need the AI's export: those files are read
// here, in the browser, and only the ones worth reading are sent: a ChatGPT export is mostly pictures, an
// OpenClaw or Hermes folder holds the program itself, its logs and its keys.

const PROMPT = `I'm moving to a new assistant and want to bring what you know about me. Write out everything you remember about me and my work, from your memory and our past chats:
- who I am, my role, and the people in my life and work
- my business: what it does, clients, suppliers, team, prices, tools, and how the work gets done
- projects and goals I'm working on, and decisions I've made
- how I like things done: tone, format, rules, things to avoid
- anything else you'd want a new assistant to know

Use plain notes grouped by topic, with dates where you know them. Give me all of it, not a summary. Put the whole thing in one code block.`;

// the AIs whose export also brings old chats; the others have only the prompt
const STEPS: Partial<Record<ImportSource, { folder: boolean; steps: string[] }>> = {
  // its own steps: claude-import.tsx
  claude: { folder: false, steps: [] },
  chatgpt: {
    folder: false,
    steps: [
      "On chatgpt.com: Settings → Data controls → Export data. You'll get an email with a link.",
      "Download the zip and pick it here.",
    ],
  },
  openclaw: {
    folder: true,
    steps: [
      "Stop OpenClaw first, so everything is written to disk.",
      "Pick your OpenClaw folder: .openclaw in your home folder (in the file picker, press Cmd+Shift+. to see hidden folders).",
    ],
  },
  hermes: {
    folder: true,
    steps: [
      "Quit Hermes first, so everything is written to disk.",
      "Pick your Hermes folder: .hermes in your home folder (in the file picker, press Cmd+Shift+. to see hidden folders).",
    ],
  },
};

// never sent: the program, caches, logs, and anything that can hold a password or key
const SKIP_DIR = /(^|\/)(node_modules|\.git|\.?venv|hermes-agent|__pycache__|logs?|cache|\.cache|media|browser|sandboxes|checkpoints|credentials|identity|bin|dist)(\/|$)/i;
const SECRET = /(^|\/)(\.env[^/]*|auth[^/]*\.json|[^/]*(token|secret|credential|password|\.key|\.pem)[^/]*)$/i;
const MB = 1024 * 1024;

function wanted(source: ImportSource, path: string, size: number) {
  const p = path.toLowerCase();
  if (source === "claude") return p.endsWith(".json") && !/(^|\/)(frames|design_chats|light_metadata)/.test(p);
  if (source === "chatgpt") return /(^|\/)conversations[^/]*\.json$/.test(p);
  if (SKIP_DIR.test(p) || SECRET.test(p)) return false;
  if (/\.(md|txt)$/.test(p)) return size < MB;
  if (p.endsWith(".jsonl")) return /(^|\/)sessions\//.test(p) && size < 50 * MB;
  if (p.endsWith("cron/jobs.json")) return true;
  return /(^|\/)(state\.db|openclaw-agent\.sqlite|openclaw\.sqlite)$/.test(p) && size < 500 * MB;
}

type Out = { path: string; text?: string; base64?: string };
const isBinary = (p: string) => /\.(db|sqlite)$/i.test(p);
const base64 = (b: Blob) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => fail(r.error);
    r.readAsDataURL(b);
  });
const read = async (path: string, b: Blob): Promise<Out> => (isBinary(path) ? { path, base64: await base64(b) } : { path, text: await b.text() });

// The entries of a zip we want, unzipped with the browser's own inflate. Reads the central directory at the end,
// then only the wanted entries' bytes.
// ponytail: no ZIP64; a zip over 4 GB says nothing found, and they can unzip it and pick the folder instead
async function unzip(file: File, keep: (path: string, size: number) => boolean): Promise<Out[]> {
  const tail = new DataView(await file.slice(Math.max(0, file.size - 65_557)).arrayBuffer());
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) return [];
  const count = tail.getUint16(end + 10, true);
  const dir = new DataView(await file.slice(tail.getUint32(end + 16, true), tail.getUint32(end + 16, true) + tail.getUint32(end + 12, true)).arrayBuffer());
  const out: Out[] = [];
  for (let i = 0, at = 0; i < count; i++) {
    const method = dir.getUint16(at + 10, true);
    const packed = dir.getUint32(at + 20, true);
    const size = dir.getUint32(at + 24, true);
    const [nameLen, extraLen, commentLen] = [dir.getUint16(at + 28, true), dir.getUint16(at + 30, true), dir.getUint16(at + 32, true)];
    const local = dir.getUint32(at + 42, true);
    const path = new TextDecoder().decode(new Uint8Array(dir.buffer, at + 46, nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith("/") || !keep(path, size) || (method !== 0 && method !== 8)) continue;
    const head = new DataView(await file.slice(local, local + 30).arrayBuffer());
    const start = local + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    const raw = file.slice(start, start + packed);
    const data = method === 0 ? raw : await new Response(raw.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
    out.push(await read(path, data));
  }
  return out;
}

async function send(source: ImportSource, picked: File[]) {
  const files: Out[] = [];
  for (const f of picked) {
    // a folder's files carry their path inside it, minus the folder itself
    const path = (f.webkitRelativePath || f.name).split("/").slice(f.webkitRelativePath ? 1 : 0).join("/");
    if (/\.zip$/i.test(f.name)) {
      if (source === "claude" && /^(frames|design_chats|light_metadata)/i.test(f.name)) continue;
      files.push(...(await unzip(f, (p, size) => wanted(source, p, size))));
    } else if (wanted(source, path, f.size)) files.push(await read(path, f));
  }
  if (!files.length) throw new Error(`Nothing from ${IMPORT_SOURCES[source]} in what you picked. Check the steps above.`);
  return post(source, files);
}

async function post(source: ImportSource, files: Out[]) {
  const body = await new Response(new Blob([JSON.stringify({ source, files })]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
  const res = await fetch(`${API_URL}/imports`, { method: "POST", credentials: "include", headers: { "content-type": "application/gzip" }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? data.message ?? "Something went wrong");
  return data as ImportResult;
}

export function ImportPage() {
  const router = useRouter();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <h1 className="px-2 font-sans text-sm font-medium tracking-normal">Bring your memory</h1>
      </header>
      <div className="under-tabs min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-6">
          <div>
            <h2 className="font-heading text-xl">Bring what another AI knows about you</h2>
            <p className="mt-1 text-sm text-muted-foreground">{ABOUT}</p>
          </div>
          <ImportPanel done={{ label: "Back to chat", go: () => router.replace("/home") }} />
        </div>
      </div>
    </div>
  );
}

export const ABOUT =
  "Bring what it learned about you and your work, and your old chats, so Emplio doesn't start from zero. Your old chats stay private to you; Emplio sorts the rest: business facts into company knowledge, the rest into your own notes.";

// Pick the AI, follow its steps, pick the files; also the welcome page's step (welcome-page.tsx)
export function ImportPanel({ done: after }: { done?: { label: string; go: () => void } }) {
  const [source, setSource] = useState<ImportSource | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const run = useMutation({ mutationFn: (files: File[]) => send(source!, files) });
  const paste = useMutation({ mutationFn: (text: string) => post(source!, [{ path: "pasted-memory.md", text }]) });
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const [chatsToo, setChatsToo] = useState(false);
  const steps = source && STEPS[source];
  const pick = (s: ImportSource | null) => (run.reset(), paste.reset(), setText(""), setChatsToo(false), setSource(s));
  const label = source && IMPORT_SOURCES[source];
  const done = run.data ?? paste.data;

  return done ? (
    <div className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
      <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="flex-1">
        <div className="font-medium">
          Brought over {done.notes} file{done.notes === 1 ? "" : "s"} and {done.chats} old chat{done.chats === 1 ? "" : "s"} from {label}
          {done.made > 0 && `, and ${done.made} thing${done.made === 1 ? "" : "s"} it made (now in Files)`}.
        </div>
        <div className="text-muted-foreground">
          {done.sorting ? "Emplio is sorting them now and will tell you in your main chat when it's done." : "Those chats were already here."}
        </div>
        <div className="mt-3 flex gap-2">
          {after && (
            <Button size="sm" onClick={after.go}>
              {after.label}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => pick(null)}>
            Bring more
          </Button>
        </div>
      </div>
    </div>
  ) : (
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(Object.keys(IMPORT_SOURCES) as ImportSource[]).map((s) => (
          <Button key={s} variant={s === source ? "default" : "outline"} disabled={run.isPending || paste.isPending} onClick={() => pick(s)}>
            {s === "other" ? "Another AI" : IMPORT_SOURCES[s]}
          </Button>
        ))}
      </div>
      {source && (
        <div className="grid gap-4 rounded-xl border p-4 text-sm">
          <div>
            <div className="font-medium">1. Ask {label} what it knows about you</div>
            <p className="mt-0.5 text-muted-foreground">Copy this, send it to {label} in a new chat, and copy its whole answer.</p>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 font-sans text-xs text-muted-foreground">{PROMPT}</pre>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => copyText(PROMPT).then(() => (setCopied(true), setTimeout(() => setCopied(false), 2000)))}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? "Copied" : "Copy the prompt"}
            </Button>
          </div>
          <div>
            <div className="font-medium">2. Paste its answer here</div>
            <p className="mt-0.5 text-muted-foreground">Read it first and take out anything you don't want Emplio to have, like passwords.</p>
            <Textarea className="mt-2 min-h-40" value={text} onChange={(e) => setText(e.target.value)} placeholder={`${label}'s answer`} />
            <Button className="mt-2" disabled={!text.trim() || paste.isPending} onClick={() => paste.mutate(text.trim())}>
              {paste.isPending ? "Saving…" : "Save"}
            </Button>
            {paste.error && <p className="mt-2 text-destructive">{paste.error.message}</p>}
          </div>
          {steps && !chatsToo && (
            <button type="button" className="justify-self-start text-xs text-muted-foreground underline underline-offset-2" onClick={() => setChatsToo(true)}>
              Want your old {label} chats too? Bring its export instead
            </button>
          )}
        </div>
      )}
      {source === "claude" && chatsToo && (
        <div className="rounded-xl border p-4">
          <ClaudeImport busy={run.isPending} error={run.error?.message} onFiles={(files) => run.mutate(files)} />
        </div>
      )}
      {steps && source !== "claude" && chatsToo && (
        <div className="rounded-xl border p-4">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            {steps.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <input
            ref={input}
            type="file"
            hidden
            multiple
            accept={steps.folder ? undefined : ".zip,.json"}
            {...(steps.folder && { webkitdirectory: "" })}
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (files.length) run.mutate(files);
            }}
          />
          <Button className="mt-4 gap-1.5" disabled={run.isPending} onClick={() => input.current?.click()}>
            {steps.folder ? <FolderOpenIcon className="size-4" /> : <UploadIcon className="size-4" />}
            {run.isPending ? "Bringing it over…" : steps.folder ? `Pick your ${label} folder` : `Pick your ${label} files`}
          </Button>
          {run.error && <p className="mt-3 text-sm text-destructive">{run.error.message}</p>}
        </div>
      )}
    </div>
  );
}

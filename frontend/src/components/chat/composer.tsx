"use client";

// Emplio's message box: the chat's own (chat-view.tsx) and the same one at the foot of the app's pages (PageAsk), with
// / commands, @ mentions, quotes, files, folders and voice. useComposer holds what's in it, kept per draft key in this
// browser; Composer draws it.
import type { Mention, SentFrom } from "@emplio/shared";
import type { ChatStatus, FileUIPart } from "ai";
import { ArrowUpIcon, AtSignIcon, FileIcon, FolderIcon, PaperclipIcon, PlusIcon, SquareSlashIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  PromptInput,
  PromptInputButton,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { AttachmentTray, SAY_FILES, SAY_META, SAY_TEXT, useAttachments } from "@/components/chat/attachments";
import { eraseMark, HighlightLayer } from "@/components/chat/highlight";
import { useMentionMenu } from "@/components/chat/mention-menu";
import { QuoteChips, withQuotes, type Quote } from "@/components/chat/quote";
import { useSkillMenu } from "@/components/chat/skill-menu";
import { VoiceInput } from "@/components/chat/voice-input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useConversations } from "@/lib/api";
import { cn } from "@/lib/utils";
import { zipFolder } from "@/lib/zip-folder";

// the parts of a draft that aren't text: replies being quoted, files already uploaded, @mentions linked
export const keptDraft = <T,>(key: string | null): T[] => {
  if (!key) return [];
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]");
  } catch {
    return [];
  }
};
export const keepDraft = (key: string | null, value: unknown[]) => {
  if (!key) return;
  try {
    if (value.length) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {}
};

// What's typed and not sent yet, kept under draftKey in this browser (null: not kept). The app shell renders nothing on
// the server, so reading it here is safe.
// ponytail: files still uploading when the box closes aren't kept
export function useComposer(draftKey: string | null) {
  const [input, setInput] = useState(() => {
    try {
      return (draftKey && localStorage.getItem(draftKey)) || "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    if (!draftKey) return;
    try {
      if (input.trim()) localStorage.setItem(draftKey, input);
      else localStorage.removeItem(draftKey);
    } catch {}
  }, [draftKey, input]);
  // parts of replies being answered, sent quoted at the start of the next message (quote.tsx)
  const [quotes, setQuotes] = useState(() => keptDraft<Quote>(draftKey && `${draftKey}:quotes`));
  useEffect(() => keepDraft(draftKey && `${draftKey}:quotes`, quotes), [draftKey, quotes]);
  const box = useRef<HTMLTextAreaElement>(null);
  const skillMenu = useSkillMenu(input, setInput);
  const mentionMenu = useMentionMenu(input, setInput, box);
  // a kept draft's @mentions stay linked
  useEffect(() => keptDraft<Mention>(draftKey && `${draftKey}:mentions`).forEach(mentionMenu.link), []); // eslint-disable-line react-hooks/exhaustive-deps -- once, as it opens
  const linked = JSON.stringify(mentionMenu.linked);
  useEffect(() => keepDraft(draftKey && `${draftKey}:mentions`, JSON.parse(linked)), [draftKey, linked]);
  const attachments = useAttachments(() => keptDraft<FileUIPart>(draftKey && `${draftKey}:files`));
  useEffect(() => keepDraft(draftKey && `${draftKey}:files`, attachments.items.flatMap((a) => (a.part ? [a.part] : []))), [draftKey, attachments.items]);
  // what to colour in the box: a known /command at the start, and the linked @mentions
  const command = skillMenu.command;
  const marks = [command ? `/${command}` : "", ...mentionMenu.linked.map((m) => `@${m.label}`)];
  const canSend = (!!input.trim() || attachments.ready || quotes.some((q) => q.note.trim())) && !attachments.uploading;
  // a whole folder goes as one zip with its sub-folders kept
  const addFolder = async (picked: Promise<{ file: File; path: string }[]>) => {
    const zip = await zipFolder(await picked, 100 * 1024 * 1024);
    if (zip) attachments.add([zip]);
    else toast.error("That folder is empty or over 100 MB");
  };
  // puts text in the box with the cursor at `at`, so the / or @ menu opens as if typed
  const typeIn = (text: string, at: number) => {
    setInput(text);
    mentionMenu.moveCaret(at);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(at, at);
    });
  };
  // what's in the box as a message, and the box emptied; null while there's nothing to send
  const take = (raw: string) => {
    if (attachments.uploading || (!raw.trim() && !attachments.ready && !quotes.some((q) => q.note.trim()))) return null;
    const message = { text: withQuotes(quotes, raw), files: attachments.take(), mentions: mentionMenu.linked, command };
    setInput("");
    setQuotes([]);
    mentionMenu.clear();
    return message;
  };
  return { input, setInput, quotes, setQuotes, attachments, skillMenu, mentionMenu, command, marks, canSend, box, addFolder, typeIn, take };
}

type Props = {
  c: ReturnType<typeof useComposer>;
  onSend: (text: string) => void;
  placeholder: string;
  // while a reply streams: stop when the box is empty, queue when there's something to send
  busy?: boolean;
  status?: ChatStatus;
  onStop?: () => void;
  // over the box, under the menus (the chat's agents at work)
  above?: React.ReactNode;
  autoFocus?: boolean;
  // room for a few lines (a new chat)
  roomy?: boolean;
  tip?: string;
};

export function Composer({ c, onSend, placeholder, busy = false, status, onStop, above, autoFocus, roomy, tip }: Props) {
  const { input, setInput, quotes, setQuotes, attachments, skillMenu, mentionMenu, marks, canSend, box, addFolder, typeIn } = c;
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  return (
    <div className="relative">
      {skillMenu.menu ?? mentionMenu.menu}
      {above}
    <PromptInput
      data-tip={tip}
      onSubmit={({ text }) => onSend(text)}
      className="rounded-3xl shadow-sm transition-shadow focus-within:shadow-md [&_[data-slot=input-group]]:h-auto [&_[data-slot=input-group]]:flex-col [&_[data-slot=input-group]]:rounded-3xl [&_[data-slot=input-group]]:bg-card [&_[data-slot=input-group]]:ring-0! [&_[data-slot=input-group]]:focus-within:border-foreground/25"
    >
      {(attachments.items.length > 0 || quotes.length > 0) && (
        <PromptInputHeader className="p-0">
          {quotes.length > 0 && <QuoteChips quotes={quotes} onChange={setQuotes} />}
          {attachments.items.length > 0 && <AttachmentTray items={attachments.items} onRemove={attachments.remove} onRetry={attachments.retry} />}
        </PromptInputHeader>
      )}
      {/* one line, send at its end; the tools sit under the box */}
      <div className="flex w-full items-end">
      {/* on a phone a row under the box is wasted height: attach, skill and mention fold into one + in it */}
      <div className="hidden h-12 items-center pl-2 pointer-coarse:flex" onMouseDown={(e) => e.preventDefault()}>
        <DropdownMenu>
          <DropdownMenuTrigger render={<PromptInputButton aria-label="More" className="rounded-full text-muted-foreground" />}>
            <PlusIcon className="size-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={10}>
            <DropdownMenuItem onClick={() => fileInput.current?.click()}>
              <PaperclipIcon /> Attach
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => typeIn(input.startsWith("/") ? input : `/${input}`, 1)}>
              <SquareSlashIcon /> Commands
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const text = `${input}${input && !/\s$/.test(input) ? " " : ""}@`;
                typeIn(text, text.length);
              }}
            >
              <AtSignIcon /> Mention
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="relative min-w-0 flex-1">
        <HighlightLayer text={input} marks={marks} />
        <PromptInputTextarea
          ref={box}
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            mentionMenu.onKeyDown(e);
            if (!e.defaultPrevented) skillMenu.onKeyDown(e);
            eraseMark(e, input, marks, setInput);
          }}
          onSelect={mentionMenu.onSelect}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (!files.length) return;
            e.preventDefault();
            attachments.add(files);
          }}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className={cn("px-5 py-3 text-[0.9rem] leading-6 placeholder:truncate pointer-coarse:px-1", roomy ? "min-h-24" : "min-h-0")}
        />
      </div>
        {/* mic and send share one row, centred on each other and on the first line of text */}
        <div className="flex h-12 items-center gap-1 pr-2">
        {/* a press keeps the focus in the box */}
        <div className="flex" onMouseDown={(e) => e.preventDefault()}>
          <VoiceInput onText={(text) => setInput((current) => [current.trim(), text].filter(Boolean).join(" "))} />
        </div>
        {/* not `disabled`: the input group fades itself out when anything inside is disabled */}
        {/* while a reply streams: stop when the box is empty, queue when there's something to send */}
        <PromptInputSubmit
          status={busy && !canSend ? status : undefined}
          onStop={onStop}
          aria-disabled={!busy && !canSend}
          aria-label={busy ? (canSend ? "Queue message" : "Stop") : "Send"}
          className="size-8 rounded-full aria-disabled:opacity-40"
        >
          {busy && !canSend ? undefined : <ArrowUpIcon className="size-4" />}
        </PromptInputSubmit>
        </div>
      </div>
    </PromptInput>
      {/* A press keeps the focus in the box. Losing it brings the phone's tab bar back at once, which moves these
          buttons out from under the finger before it lifts, and the tap is lost. */}
      <div className="mt-1 flex items-center justify-between gap-2 px-2 pointer-coarse:hidden" onMouseDown={(e) => e.preventDefault()}>
        <PromptInputTools>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              attachments.add([...(e.currentTarget.files ?? [])]);
              e.currentTarget.value = "";
            }}
          />
          {/* a browser picker takes files or a folder, never both, so the one clip asks which */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<PromptInputButton aria-label="Attach" className="rounded-full text-muted-foreground" />}
            >
              <PaperclipIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start">
              <DropdownMenuItem onClick={() => fileInput.current?.click()}>
                <FileIcon /> Files
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => folderInput.current?.click()}>
                <FolderIcon /> Folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* a whole folder goes as one zip with its sub-folders kept */}
          <input
            ref={folderInput}
            type="file"
            className="hidden"
            {...{ webkitdirectory: "" }}
            onChange={async (e) => {
              const picked = [...(e.currentTarget.files ?? [])].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
              e.currentTarget.value = "";
              if (picked.length) await addFolder(Promise.resolve(picked));
            }}
          />
          {/* the same menus typing / or @ opens, for people who don't know to type them */}
          <PromptInputButton
            tooltip="Commands"
            aria-label="Commands"
            onClick={() => typeIn(input.startsWith("/") ? input : `/${input}`, 1)}
            className="rounded-full text-muted-foreground"
          >
            <SquareSlashIcon className="size-4" />
          </PromptInputButton>
          <PromptInputButton
            tooltip="Mention"
            aria-label="Mention"
            onClick={() => {
              const text = `${input}${input && !/\s$/.test(input) ? " " : ""}@`;
              typeIn(text, text.length);
            }}
            className="rounded-full text-muted-foreground"
          >
            <AtSignIcon className="size-4" />
          </PromptInputButton>
        </PromptInputTools>
        {/* only with a mouse or trackpad: on a touch screen (iPad too) Enter is a new line (prompt-input.tsx) */}
        <span className="hidden text-xs text-muted-foreground sm:pointer-fine:inline">Shift + Enter for a new line</span>
      </div>
    </div>
  );
}

// What's open on a page, for the box to start with its @mention and for Emplio to be told about (backend chat.ts
// sentFromNote). ref: its file under /work (a client's, project's, process's or note's), a task's id or a table's name.
export type Open = NonNullable<SentFrom["open"]>;
const mentionOf = (o: Open): Mention => ({
  kind: o.kind === "task" ? "task" : o.kind === "table" ? "table" : o.kind === "process" || o.kind === "note" ? "file" : "record",
  id: o.ref,
  label: o.title,
});

// Emplio's message box at the foot of a page, or of a side sheet (sheet): what's sent goes into the main chat, which
// opens and sends it (chat-view.tsx picks SAY_TEXT up) with a hidden note of where it was sent from. With a thing
// open, the box starts with its @mention, theirs to delete; that box isn't kept as a draft, the page's own is.
// className: for a box under a page's panes rather than in its scroll (Memory's notes and database)
export function PageAsk({ open, sheet }: { open?: Open | null; sheet?: boolean }) {
  const page = usePathname().split("/")[1] ?? "";
  // a fresh box for each thing opened
  return <PageBox key={open ? `${open.kind}:${open.ref}` : page} page={page} open={open ?? undefined} sheet={sheet} />;
}

// The pages' own box lives once in the app's layout (LayoutAsk); a page with a thing open on it (a process, a note,
// a table) says so with useAskOpen, and the box starts with its @mention.
// ponytail: one page shows at a time, so one value is enough
let shown: Open | null = null;
const listeners = new Set<() => void>();
export function useAskOpen(open: Open | null | undefined) {
  const k = open ? `${open.kind}:${open.ref}:${open.title}` : "";
  useEffect(() => {
    shown = open ?? null;
    listeners.forEach((f) => f());
    return () => {
      shown = null;
      listeners.forEach((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- k is open, by value
  }, [k]);
}
const ASK_PAGES = ["today", "tasks", "clients", "projects", "contacts", "services", "processes", "knowledge", "database", "files", "team"];
export function LayoutAsk() {
  const open = useSyncExternalStore(
    (f) => (listeners.add(f), () => void listeners.delete(f)),
    () => shown,
    () => null,
  );
  const page = usePathname().split("/")[1] ?? "";
  // the chat puts its own box here (chat-view.tsx, through #ask-slot): the same place on every page
  const chat = page === "chat" || page === "home";
  if (!chat && !ASK_PAGES.includes(page)) return null;
  // over the foot of the page, fading it out; on a phone, above the bottom tabs (globals.css .page-ask)
  return (
    <div className="page-ask pointer-events-none relative z-10 -mt-6 shrink-0 bg-linear-to-t from-background from-70% to-transparent pt-6 pb-[max(0.75rem,var(--safe-bottom))] max-md:pb-[calc(var(--tabs-h)+0.75rem)]">
      <div id="ask-slot" className="pointer-events-auto">
        {!chat && <PageAsk open={open} />}
      </div>
    </div>
  );
}

function PageBox({ page, open, sheet }: { page: string; open?: Open; sheet?: boolean }) {
  const router = useRouter();
  const { data: conversations } = useConversations();
  const main = conversations?.find((x) => x.kind === "main");
  const c = useComposer(open ? null : `page_draft:${page}`);
  useEffect(() => {
    if (!open) return;
    const m = mentionOf(open);
    c.mentionMenu.link(m);
    c.setInput((t) => (t.trim() ? t : `@${m.label} `));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once: the box is new for each thing
  }, []);
  const send = (raw: string) => {
    const m = c.take(raw);
    if (!m) return;
    const from: SentFrom = { page, ...(open && { open }) };
    try {
      sessionStorage.setItem(SAY_TEXT, m.text.trim() || "Here are some files.");
      sessionStorage.setItem(SAY_FILES, JSON.stringify(m.files));
      sessionStorage.setItem(SAY_META, JSON.stringify({ mentions: m.mentions, command: m.command, from }));
    } catch {}
    router.push(main ? `/chat/${main.id}` : "/chat");
  };
  const box = <Composer c={c} onSend={send} placeholder="Ask Emplio anything…" />;
  return sheet ? (
    <div className="shrink-0 border-t px-3 pt-3 pb-[max(0.75rem,var(--safe-bottom))]">{box}</div>
  ) : (
    <div className="mx-auto w-full max-w-3xl px-4">{box}</div>
  );
}

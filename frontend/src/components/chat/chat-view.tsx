"use client";

import { copyText, uuid } from "@/lib/utils";
import { useChat } from "@ai-sdk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AUTOMATION_PREFIX, BRIEF_PREFIX, CHECK_IN_PREFIX, LEARNED_PREFIX, REPORT_PREFIX, RESUMED_PREFIX, TASK_PREFIX, JOB_NOTE_PREFIX, JOBS_DONE_PREFIX, SHOWN_PREFIX, WORKERS_DONE_PREFIX, FROM_EMPLIO, type ChatJob, type Mention, type NextStep } from "@emplio/shared";
import type { FileUIPart, UIMessage } from "ai";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  CornerDownRightIcon,
  PaperclipIcon,
  PencilIcon,
  RefreshCcwIcon,
  SendIcon,
  TriangleAlertIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { cn } from "@/lib/utils";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion } from "@/components/ai-elements/suggestion";
import { RenameInput } from "@/components/chat/app-sidebar";
import { VoiceInput } from "@/components/chat/voice-input";
import { AssistantParts, doing } from "@/components/chat/tool-calls";
import { ChatSendContext } from "@/components/chat/connect-card";
import { ReplyContext } from "@/components/chat/ask-card";
import { BrowserChip, BrowserPanel, BrowserProvider, useLiveBrowser } from "@/components/chat/browser-panel";
import { FilePanel, OpenFileProvider, type Shown } from "@/components/files/file-viewer";
import { AssistantReply, CLICK_PREFIX, userFacingText } from "@/components/chat/assistant-reply";
import { NextStepCard } from "@/components/chat/next-step-card";
import { useSkillMenu } from "@/components/chat/skill-menu";
import { useMentionMenu } from "@/components/chat/mention-menu";
import { eraseMark, HighlightLayer } from "@/components/chat/highlight";
import { AttachmentTray, MessageAttachments, SAY_FILES, SAY_TEXT, useAttachments } from "@/components/chat/attachments";
import { QuoteButton, QuoteChips, QuotedText, addQuote, withQuotes, type Quote } from "@/components/chat/quote";
import { Button } from "@/components/ui/button";
import { pausedNote, useCreditStatus } from "@cloud/client";
import { type Channels, channelsQueryKey } from "@/components/chat/channels-dialog";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  api,
  chatTransport,
  conversationsQueryKey,
  useConversations,
  useMe,
  useRenameConversation,
} from "@/lib/api";

const SUGGESTIONS = [
  "Draft a project update for my team",
  "Summarize the key points of a meeting",
  "Write a polite follow-up email",
  "Help me plan my week",
];

// px: space above a pinned prompt, and the message list's bottom padding (py-8)
const PIN_GAP = 16;
const LIST_PADDING = 32;
// a long chat opens with its latest turns drawn; reaching the top draws this many more
const TURNS_SHOWN = 12;

const textOf = (message: UIMessage) =>
  message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
const filesOf = (message: UIMessage) => message.parts.filter((p): p is FileUIPart => p.type === "file");

// command: the / skill or app the text starts with, picked from the menu (kept with the message for highlighting)
// steered: the running reply knows it's waiting, and ends after its current command so this goes in next
type Queued = { id: string; text: string; files: FileUIPart[]; mentions?: Mention[]; command?: string; steered?: boolean };

// the / command and @mentions a sent message was written with, to colour them in its bubble
const sentMarks = (message: UIMessage) => {
  const part = (type: string) => (message.parts.find((p) => p.type === type) as { data?: unknown } | undefined)?.data;
  const command = part("data-command");
  return [typeof command === "string" ? `/${command}` : "", ...((part("data-mentions") as Mention[] | undefined) ?? []).map((m) => `@${m.label}`)];
};
// where clicking a sent @mention goes: a note to the Knowledge page, a task to Tasks, a chat to that chat
const sentLinks = (message: UIMessage) =>
  Object.fromEntries(
    (((message.parts.find((p) => p.type === "data-mentions") as { data?: Mention[] } | undefined)?.data ?? []) as Mention[]).flatMap((m) =>
      m.kind === "file" || m.kind === "record"
        ? [[`@${m.label}`, `/knowledge?file=${encodeURIComponent(m.id)}`]]
        : m.kind === "chat"
          ? [[`@${m.label}`, `/chat/${m.id}`]]
          : m.kind === "task"
            ? [[`@${m.label}`, `/tasks?task=${m.id}`]]
            : [],
    ),
  );

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// job: this is a job's own chat (backend jobs.ts): its header names the agent, and it closes out of the sidebar
type Props = { id: string; title?: string; initialMessages: UIMessage[]; initialOlder?: string | null; isNew?: boolean; job?: ChatJob };

// the parts of a draft that aren't text: replies being quoted, files already uploaded
const keptDraft = <T,>(key: string): T[] => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]");
  } catch {
    return [];
  }
};
const keepDraft = (key: string, value: unknown[]) => {
  try {
    if (value.length) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {}
};

export function ChatView({ id, title, initialMessages, initialOlder, isNew, job }: Props) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: me } = useMe();
  const { data: conversations } = useConversations();
  // what's typed and not sent yet, kept per chat in this browser (one slot for the new-chat screen); the
  // app shell renders nothing on the server, so reading it here is safe
  // ponytail: @mention links and files still uploading when the chat closes aren't kept
  const draftKey = `chat_draft:${isNew ? "new" : id}`;
  const [input, setInput] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  // a kept draft opens with the cursor after it, ready to go on typing
  useEffect(() => {
    const box = document.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    box?.setSelectionRange(box.value.length, box.value.length);
  }, []);
  useEffect(() => {
    try {
      if (input.trim()) localStorage.setItem(draftKey, input);
      else localStorage.removeItem(draftKey);
    } catch {}
  }, [draftKey, input]);
  // parts of replies being answered, sent quoted at the start of the next message (quote.tsx)
  const [quotes, setQuotes] = useState(() => keptDraft<Quote>(`${draftKey}:quotes`));
  useEffect(() => keepDraft(`${draftKey}:quotes`, quotes), [draftKey, quotes]);
  const skillMenu = useSkillMenu(input, setInput);
  const mentionMenu = useMentionMenu(input, setInput);
  // /chat?file=company/x.md: the new chat with that file already @mentioned, cursor after it (Knowledge's
  // "Suggest a change"). On the URL, not once on open: the new-chat screen stays mounted between visits.
  const aboutFile = useSearchParams().get("file");
  useEffect(() => {
    if (!isNew || !aboutFile) return;
    const label = aboutFile.split("/").pop()!;
    const text = `Change @${label} `;
    mentionMenu.link({ kind: "file", id: aboutFile, label, detail: aboutFile.split("/").slice(0, -1).join("/") });
    setInput(text);
    requestAnimationFrame(() => {
      const box = document.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
      box?.focus();
      box?.setSelectionRange(text.length, text.length);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- when a file is asked about
  }, [aboutFile]);
  // what to colour in the box: a known /command at the start, and the linked @mentions
  const command = skillMenu.command;
  const marks = [command ? `/${command}` : "", ...mentionMenu.linked.map((m) => `@${m.label}`)];
  const urlUpdated = useRef(!isNew);

  // the server is first summarising a long chat into notes (backend compact.ts), which takes a while
  const [summarizing, setSummarizing] = useState(false);
  // out of usage: the server's reply is why (credit.ts pausedReason), not a failure to retry
  const paused = useCreditStatus().data?.paused;
  const { messages, setMessages, sendMessage, status, stop, regenerate, error, clearError, resumeStream } = useChat({
    id,
    messages: initialMessages,
    transport: chatTransport,
    // a reply still being written (sent before switching chats, from another tab or device): replay and follow it
    resume: !isNew,
    // about one redraw per streamed word (the server sends one every 25ms), so words fade in one by one
    // instead of in pairs; only the reply being written is drawn again
    throttle: 32,
    onData: (part) => {
      if (part.type === "data-summarizing") setSummarizing(!!part.data);
    },
    onFinish: ({ messages }) => {
      queryClient.invalidateQueries({ queryKey: conversationsQueryKey });
      // the AI title is generated alongside the first reply and can land a moment later
      if (messages.length <= 2)
        setTimeout(() => queryClient.invalidateQueries({ queryKey: conversationsQueryKey }), 2500);
    },
  });
  // a long chat comes in pages, latest first: `older` is what to ask for when scrolling reaches the top (null: all here)
  const [older, setOlder] = useState(initialOlder ?? null);
  const loadingOlder = useRef(false);
  const onScreen = useRef(0);
  useLayoutEffect(() => {
    onScreen.current = messages.length;
  }, [messages]);
  // a refresh from the server: as many as are on screen, so reading further back doesn't lose its place, and room for
  // what's new (too few and the newest would crowd out the message just sent, which then looks lost)
  const fetchChat = () =>
    api<{ messages: UIMessage[]; running: boolean; older: string | null }>(`/conversations/${id}${onScreen.current ? `?limit=${onScreen.current + 20}` : ""}`);

  // Leaving the chat stops following its reply (it goes on, and shows as unread when it ends unseen).
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => () => void stopRef.current(), []);

  // Typing outside any text field (nothing focused, or a button or link) goes into the message box
  // (focused before the key lands, so it keeps the letter). Space on a button still presses it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
      if (e.key === " " && el && el !== document.body) return;
      if (document.querySelector("[role=dialog], [role=menu], [role=listbox]")) return;
      const box = document.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Once the server has created the conversation, show it in the sidebar right away.
  useEffect(() => {
    if (status === "streaming") queryClient.invalidateQueries({ queryKey: conversationsQueryKey });
  }, [status, queryClient]);

  const busy = status === "submitted" || status === "streaming";
  if (summarizing && !busy) setSummarizing(false);

  // A message or reply that came from elsewhere while this chat is open (Telegram, a task, a check-in): the
  // chat list's nudge shows it changed, so load what's new and follow a reply still being written.
  const summary = conversations?.find((c) => c.id === id);
  const change = summary && `${summary.updatedAt}|${summary.running}`;
  const seen = useRef(change);
  // bumped on every send: a load that started before it would wipe the sent message off the screen (a queued
  // message goes out the moment a reply ends, just as this loads), and follow the wrong reply
  const sends = useRef(0);

  // The connection was cut (a phone does this to an app in the background), but the reply goes on at the server:
  // no error. Once the app is back on screen, load what was written and follow the rest. The error only shows if
  // the server can't be reached after a few tries, never got the message, or ended without replying.
  const dropped = error instanceof TypeError && error.message.includes("network connection");
  const [gaveUpOn, setGaveUpOn] = useState<Error>();
  const reconnecting = dropped && gaveUpOn !== error;
  const tries = useRef(0);
  // back from a drop: messages waiting in line go out as if the reply had just ended
  const recovered = useRef(false);
  useEffect(() => {
    if (status === "streaming") tries.current = 0;
  }, [status]);
  useEffect(() => {
    if (!dropped) return;
    let left = false;
    let loading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      clearTimeout(timer);
      if (left || loading || document.hidden) return;
      if (tries.current++ >= 15) return setGaveUpOn(error);
      loading = true;
      const at = sends.current;
      try {
        const d = await fetchChat();
        if (left || sends.current !== at) return;
        const sent = messages.findLast((m) => m.role === "user");
        if (sent && !d.messages.some((m) => m.id === sent.id)) return setGaveUpOn(error);
        setMessages(d.messages);
        setOlder(d.older);
        // no reply yet: one picked up after a restart has saved its message but takes a moment to start
        if (!d.running && d.messages.at(-1)?.role === "user") return void (timer = setTimeout(attempt, 2000));
        recovered.current = true;
        if (d.running) return void resumeStream();
        tries.current = 0;
        clearError();
      } catch {
        if (!left) timer = setTimeout(attempt, 2000);
      } finally {
        loading = false;
      }
    };
    void attempt();
    document.addEventListener("visibilitychange", attempt);
    window.addEventListener("online", attempt);
    return () => {
      left = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", attempt);
      window.removeEventListener("online", attempt);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once for each drop
  }, [error]);

  useEffect(() => {
    if (!change || busy || reconnecting || change === seen.current) return;
    const first = seen.current === undefined;
    seen.current = change;
    if (first) return;
    const at = sends.current;
    void fetchChat().then((d) => {
      if (sends.current !== at) return;
      setMessages(d.messages);
      setOlder(d.older);
      // after giving up on a drop: the reply came after all, so the error is out of date
      if (d.running) void resumeStream();
      else if (dropped && d.messages.at(-1)?.role === "assistant") clearError();
    });
  }, [change, busy, dropped, reconnecting, id, setMessages, resumeStream, clearError]);
  const empty = messages.length === 0;
  // a job's chat: its line in the sidebar spins while it replies
  useEffect(() => {
    if (job) void queryClient.invalidateQueries({ queryKey: ["jobs"] });
  }, [job, status, queryClient]);
  const browser = useLiveBrowser(id, messages);
  // a file the AI made, open in the side panel; one panel at a time: the browser showing puts the file away
  const [openFile, setOpenFile] = useState<Shown | null>(null);
  const showFile = useCallback((f: Shown) => {
    setOpenFile({ ...f, conversationId: id });
    browser.hide();
  }, [browser, id]);

  const attachments = useAttachments(() => keptDraft<FileUIPart>(`${draftKey}:files`));
  useEffect(() => keepDraft(`${draftKey}:files`, attachments.items.flatMap((a) => (a.part ? [a.part] : []))), [draftKey, attachments.items]);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [pinLatest, setPinLatest] = useState(false);

  const dispatch = ({ text, files, mentions, command }: Omit<Queued, "id">) => {
    if (!urlUpdated.current) {
      // swap the URL without remounting so the stream keeps going
      window.history.replaceState(null, "", `/chat/${id}`);
      urlUpdated.current = true;
    }
    sends.current++;
    clearError();
    setPinLatest(true);
    // @mentions ride along as a data part, saved with the message (backend/src/mentions.ts)
    if (mentions?.length || command)
      sendMessage({
        parts: [
          ...files,
          { type: "text", text },
          ...(mentions?.length ? [{ type: "data-mentions" as const, data: mentions }] : []),
          ...(command ? [{ type: "data-command" as const, data: command }] : []),
        ],
      });
    else sendMessage(text ? { text, files } : { files });
  };

  // A new chat that starts with what one of our pages left for it (Settings' "Brief your AI employee"; the welcome page)
  useEffect(() => {
    if (!isNew || messages.length) return;
    // a tick later, and called off if the chat closes first: in development React opens every page twice, and
    // the first close stops (stopRef) the send it had just started, so nothing went out
    const later = setTimeout(() => {
      let say: string | null = null;
      let files: FileUIPart[] = [];
      try {
        say = sessionStorage.getItem(SAY_TEXT);
        if (!say) return;
        sessionStorage.removeItem(SAY_TEXT);
        files = JSON.parse(sessionStorage.getItem(SAY_FILES) ?? "[]");
        sessionStorage.removeItem(SAY_FILES);
      } catch {}
      if (say) dispatch({ text: say, files });
    });
    return () => clearTimeout(later);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the chat opens
  }, []);

  const canSend = (!!input.trim() || attachments.ready || quotes.some((q) => q.note.trim())) && !attachments.uploading;

  // While a reply is in progress, new messages wait in line and go out one by one.
  const send = (raw: string) => {
    if (attachments.uploading || (!raw.trim() && !attachments.ready && !quotes.some((q) => q.note.trim()))) return;
    const text = withQuotes(quotes, raw);
    const message = { text, files: attachments.take(), mentions: mentionMenu.linked, command };
    if (busy || queue.length) enqueue({ id: uuid(), ...message });
    else dispatch(message);
    setInput("");
    setQuotes([]);
    mentionMenu.clear();
  };

  // Waiting in line, sent as their own message when the reply ends. The running reply is told, so it ends
  // after its current command instead of finishing the whole job first, and the next one carries on from there.
  const enqueue = (item: Queued) => setQueue((q) => [...q, item]);
  // also the ones left after the first is sent: the reply it starts is told about them in turn
  useEffect(() => {
    if (status !== "streaming") return;
    for (const item of queue.filter((x) => !x.steered))
      void api<{ ok: boolean }>(`/conversations/${id}/steer`, { id: item.id, text: item.text })
        .then((r) => r.ok && setQueue((q) => q.map((x) => (x.id === item.id ? { ...x, steered: true } : x))))
        .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once a reply is running, for each new one waiting
  }, [status, queue.length]);
  const unsteer = (item: Queued) => {
    if (item.steered) void api(`/conversations/${id}/steer/${item.id}`, undefined, "DELETE").catch(() => {});
  };

  // Send now: stop the reply where it is and send this one next.
  const sendNow = (item: Queued) => {
    setQueue((q) => [item, ...q.filter((x) => x.id !== item.id)]);
    stop();
    void api(`/conversations/${id}/stop`, { keepJobs: true }).catch(() => {});
  };

  // A message the app sends for the person (a connect card saying it's done), queued like a typed one.
  const sendText = (text: string) => {
    if (busy || queue.length) enqueue({ id: uuid(), text, files: [] });
    else dispatch({ text, files: [] });
  };

  // Drain only on the moment a reply finishes; a failed reply leaves the queue waiting for "Continue" or "Try again".
  const prevStatus = useRef(status);
  useEffect(() => {
    const wasBusy = prevStatus.current === "submitted" || prevStatus.current === "streaming" || (status === "ready" && recovered.current);
    prevStatus.current = status;
    if (status === "ready") recovered.current = false;
    if (!wasBusy || status !== "ready" || !queue.length) return;
    const [next, ...rest] = queue;
    // the new reply has to be told about the rest again (the effect above)
    setQueue(rest.map((x) => ({ ...x, steered: false })));
    dispatch(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dispatch is recreated every render
  }, [status, queue]);

  // Editing a sent message forks the chat there: the edit goes out after the message before it, the old
  // version stays a switch away ("‹ 1 / 2 ›"). Messages loaded from the server know their versions
  // (backend chat.ts loadMessages); the chat is reloaded once the edit's reply ends, so it knows them too.
  type Versions = { parentId?: string | null; versions?: string[]; createdAt?: string };
  const [editing, setEditing] = useState<string | null>(null);
  const forked = useRef(false);
  const reload = async () => {
    const d = await fetchChat();
    setMessages(d.messages);
    setOlder(d.older);
  };
  useEffect(() => {
    if (status !== "ready" || !forked.current) return;
    forked.current = false;
    void reload().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the edit's reply ends
  }, [status]);
  // ponytail: a failed switch just doesn't happen; clicking again retries
  const showVersion = (versionId: string) =>
    api(`/conversations/${id}/head`, { at: versionId })
      .then(reload)
      .catch(() => {});
  const [editText, setEditText] = useState("");
  const saveEdit = async (message: UIMessage, i: number, text: string) => {
    // unchanged still goes: a new try at the same message
    if (!text.trim()) return setEditing(null);
    const meta = message.metadata as Versions | undefined;
    const parentId = meta?.parentId !== undefined ? meta.parentId : (messages[i - 1]?.id ?? null);
    // failed: the edit box stays open with their text, to save again
    if (!(await api(`/conversations/${id}/head`, { at: parentId, exact: true }).then(() => true, () => false))) return;
    setEditing(null);
    const part = (type: string) => (message.parts.find((p) => p.type === type) as { data?: unknown } | undefined)?.data;
    setMessages(messages.slice(0, i));
    forked.current = true;
    // a tapped answer left as it was keeps the question that goes with it, which the edit box doesn't show
    const sent = text === userFacingText(textOf(message)) ? textOf(message) : text;
    dispatch({ text: sent, files: filesOf(message), mentions: part("data-mentions") as Mention[] | undefined, command: part("data-command") as string | undefined });
  };

  // The closable card after each reply, made by a small model (backend chat.ts nextStep). Opening a chat only
  // shows one already made.
  const [nextStep, setNextStep] = useState<NextStep | null>(null);
  // How much of the chat the card floats over. Kept until the next send, so closing it or typing moves nothing.
  const [cardRoom, setCardRoom] = useState(0);
  const nextStepAfter = useRef(status);
  useEffect(() => {
    const wasBusy = nextStepAfter.current === "submitted" || nextStepAfter.current === "streaming";
    nextStepAfter.current = status;
    if (status === "submitted" || status === "streaming") {
      setCardRoom(0);
      return setNextStep(null);
    }
    if (isNew && !wasBusy) return;
    if (status !== "ready" || (wasBusy && queue.length)) return;
    let current = true;
    api<{ card: NextStep | null }>(`/conversations/${id}/next-step${wasBusy ? "" : "?peek=1"}`)
      .then((r) => current && setNextStep(r.card))
      .catch(() => {});
    return () => void (current = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on a reply finishing (and opening the chat), not as the queue changes
  }, [status, id]);
  // the bubble shows the button's words; Emplio also gets the question, since it didn't write the card itself
  const answerNextStep = (button: string) => {
    sendText(`${CLICK_PREFIX}${button}\nForm values: ${JSON.stringify({ question: nextStep?.question })}`);
    setNextStep(null);
  };
  const closeNextStep = () => {
    setNextStep(null);
    void api(`/conversations/${id}/next-step`, undefined, "DELETE").catch(() => {});
  };

  // Stopping means "hold on": queued messages come back into the composer instead of firing.
  const stopAll = () => {
    stop();
    // the server keeps going on its own unless told; this also saves what the agent changed so far
    void api(`/conversations/${id}/stop`, {}).catch(() => {});
    if (!queue.length) return;
    setInput((current) => [...queue.map((q) => q.text), current].filter(Boolean).join("\n\n"));
    attachments.restore(queue.flatMap((q) => q.files));
    setQueue([]);
  };

  const editQueued = (item: Queued) => {
    unsteer(item);
    setQueue((q) => q.filter((x) => x.id !== item.id));
    setInput((current) => [current, item.text].filter(Boolean).join("\n\n"));
    attachments.restore(item.files);
  };

  // drag files anywhere over the chat to attach them
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  const dropZone = {
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) setDragging(false);
    },
    onDragOver: (e: React.DragEvent) => hasFiles(e) && e.preventDefault(),
    // capture phase, so the prompt input's own (unused) attachment handling never sees the drop
    onDropCapture: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth.current = 0;
      setDragging(false);
      attachments.add([...e.dataTransfer.files]);
    },
  };
  const fileInput = useRef<HTMLInputElement>(null);

  // Like Claude/ChatGPT: a just-sent prompt scrolls to the top and the reply fills in below it.
  // The latest turn is made at least one viewport tall so there's room to scroll it up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [viewportHeight, setViewportHeight] = useState(0);
  // when a just-sent prompt was scrolled to the top: for a moment after, size changes keep it there
  const pinnedAt = useRef(0);
  const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
  const contentRef = useRef<HTMLDivElement>(null);
  // reading at the very end of an opened chat (not a just-sent prompt): the end stays in view as what's
  // there finishes drawing (code highlighting, images, diagrams), not just the instant it was opened
  const stuck = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // the bottom stays put when the view changes height (the phone keyboard opening), so what was just above
    // the composer still is
    let height = el.clientHeight;
    const observer = new ResizeObserver(() => {
      const pin = Date.now() - pinnedAt.current < 1500 && el.querySelector<HTMLElement>("[data-pin]");
      // ponytail: a phone's composer and keyboard settle right after sending
      if (pin) el.scrollTop = pin.offsetTop - PIN_GAP;
      else if (stuck.current) el.scrollTop = el.scrollHeight;
      // only when it did change: setting the position, even to the same value, ends a flick on an iPhone
      else if (el.clientHeight !== height) el.scrollTop += height - el.clientHeight;
      height = el.clientHeight;
      setViewportHeight(height);
    });
    observer.observe(el);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [empty]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!pinLatest) {
      // opened from a search result (#m-<id>): show that message, briefly marked; otherwise the latest
      const hit = location.hash.startsWith("#m-") ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
      if (!hit) {
        el.scrollTop = el.scrollHeight;
        return;
      }
      el.scrollTop += hit.getBoundingClientRect().top - el.getBoundingClientRect().top - PIN_GAP;
      hit.classList.add("rounded-xl", "ring-2", "ring-primary/40", "ring-offset-4", "ring-offset-background");
      setTimeout(() => hit.classList.remove("ring-2"), 2500);
      return;
    }
    const pin = el.querySelector<HTMLElement>("[data-pin]");
    if (!pin) return;
    pinnedAt.current = Date.now();
    // Go there at once and slide the content the rest of the way. Moving it (a transform) runs on the graphics
    // chip, so it stays smooth while the page is busy drawing the new message; setting scrollTop every frame, or
    // behavior: "smooth" on a phone, waits its turn behind that work and moves in jumps.
    const from = el.scrollTop;
    el.scrollTop = pin.offsetTop - PIN_GAP;
    const moved = el.scrollTop - from;
    if (!moved || !contentRef.current || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // from a long way up it starts a screen and a half away: a very tall slide is only a blur
    const most = el.clientHeight * 1.5;
    const glide = contentRef.current.animate(
      { transform: [`translateY(${Math.max(-most, Math.min(most, moved))}px)`, "none"] },
      { duration: 450, easing: "cubic-bezier(0.33, 1, 0.68, 1)" },
    );
    return () => glide.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new prompt lands
  }, [lastUserIdx]);

  // one block per prompt + its reply; stable keys so earlier turns never remount (and jump) on send
  const turns: { key: string; start: number; items: UIMessage[] }[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user" || turns.length === 0) turns.push({ key: m.id, start: i, items: [] });
    turns[turns.length - 1].items.push(m);
  });
  // opened from a search result: all of it, so the message is there to show
  const [shown, setShown] = useState(() => (location.hash.startsWith("#m-") ? Infinity : TURNS_SHOWN));
  const heightBefore = useRef(0);
  const topBefore = useRef(0);
  const lastScroll = useRef(0);
  const drawingEarlier = useRef(false);
  // Earlier turns go in once the list has stopped moving: keeping the place after they're in sets the position,
  // which ends a flick on an iPhone.
  const whenStill = (fn: () => void) => {
    const wait = lastScroll.current + 150 - Date.now();
    if (wait > 0) setTimeout(() => whenStill(fn), wait);
    else fn();
  };
  const keepPlace = () => {
    heightBefore.current = scrollRef.current?.scrollHeight ?? 0;
    topBefore.current = scrollRef.current?.scrollTop ?? 0;
  };
  const drawEarlier = () => {
    drawingEarlier.current = false;
    const el = scrollRef.current;
    if (!el || el.scrollTop >= el.clientHeight * 2) return;
    if (shown < turns.length) {
      keepPlace();
      setShown((n) => n + TURNS_SHOWN);
    } else if (older && !loadingOlder.current) {
      // everything here is drawn: the next messages back, from the server
      loadingOlder.current = true;
      void api<{ messages: UIMessage[]; older: string | null }>(`/conversations/${id}?before=${encodeURIComponent(older)}`)
        .then((d) =>
          whenStill(() => {
            keepPlace();
            setMessages((now) => [...d.messages.filter((m) => !now.some((n) => n.id === m.id)), ...now]);
            setOlder(d.older);
            setShown((n) => n + TURNS_SHOWN);
            loadingOlder.current = false;
          }),
        )
        // ponytail: scrolling again retries
        .catch(() => (loadingOlder.current = false));
    }
  };
  // The card floats over the chat, so the message area keeps its size. Only when it would cover the end of the
  // reply does the chat move, once and by just enough.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const last = document.getElementById(`m-${messages.at(-1)?.id}`);
    if (!cardRoom || !el || !last) return;
    const bottom = el.getBoundingClientRect().bottom;
    const end = last.getBoundingClientRect().bottom;
    // past the bottom edge: they've scrolled up to read something else
    if (end <= bottom && end > bottom - cardRoom) el.scrollBy({ top: end - bottom + cardRoom, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the card arrives
  }, [cardRoom]);

  const checkBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(gap < 80 + cardRoom);
    // after a send the reply fills in below the prompt instead (pinLatest)
    stuck.current = !pinLatest && gap < 2;
    // two screens ahead, so a pause in scrolling has them ready before the top is reached
    if (el.scrollTop >= el.clientHeight * 2 || drawingEarlier.current) return;
    drawingEarlier.current = true;
    whenStill(drawEarlier);
  };
  // earlier turns drawn in above: stay on what was being read
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && heightBefore.current) el.scrollTop = topBefore.current + el.scrollHeight - heightBefore.current;
    heightBefore.current = 0;
  }, [shown]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- as messages come in (and a short start fills the screen)
  useEffect(checkBottom, [messages]);

  // same slot the reply text renders in, so it doesn't jump when the first words arrive
  // keyed by the words, so each new step writes itself in (globals.css .type-in)
  const thinking = (message?: UIMessage) => {
    const now = summarizing ? "Summarizing the conversation…" : doing(message);
    return (
      now && (
        <div key={now} className="type-in" style={{ "--type-len": now.length } as React.CSSProperties}>
          <Shimmer className="text-[15px] leading-relaxed">{now}</Shimmer>
        </div>
      )
    );
  };

  const renderMessage = (message: UIMessage, i: number) => {
    const isLast = i === messages.length - 1;
    const text = textOf(message);
    // when it was said, where the chat picks up after a while or the AI wrote on its own (a check-in, a task's
    // result): the main chat is weeks long, and otherwise reads as one message
    const at = (m?: UIMessage) => (m?.metadata as Versions | undefined)?.createdAt;
    const prev = messages[i - 1];
    const stamp =
      at(message) &&
      (!prev ||
        (message.role === "assistant" && prev.role !== "user") ||
        new Date(at(message)!).getTime() - new Date(at(prev) ?? 0).getTime() > 3_600_000)
        ? when(new Date(at(message)!))
        : null;
    // instructions for the agent (a check-in, an automation, a task) or jobs' late reports: just say what happened
    const DIVIDERS = [
      [CHECK_IN_PREFIX, "Check-in"],
      [BRIEF_PREFIX, "Morning brief"],
      [REPORT_PREFIX, "End-of-day report"],
      [JOBS_DONE_PREFIX, "Work finished"],
      [SHOWN_PREFIX, "You showed Emplio how"],
      [JOB_NOTE_PREFIX, "Message from Emplio's work"],
      [WORKERS_DONE_PREFIX, "Work finished"],
      [RESUMED_PREFIX, "Picked up after a restart"],
      [AUTOMATION_PREFIX, "Automation started"],
      [TASK_PREFIX, "Task started"],
    ];
    // and a skill review's note of what it saved, as one line
    const divider =
      message.role === "user"
        ? (DIVIDERS.find(([p]) => text.startsWith(p!))?.[1] ?? null)
        : text.startsWith(LEARNED_PREFIX) && `Learned: ${text.slice(LEARNED_PREFIX.length).split("\n")[0]}`;
    const line = (label: string, key?: string, id?: string) => (
      <div key={key} id={id} className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        {label}
        <span className="h-px flex-1 bg-border" />
      </div>
    );
    if (divider) return line(stamp ? `${divider} · ${stamp}` : divider, message.id, `m-${message.id}`);
    // in a job's chat: what Emplio told it, labelled, beside what the person wrote to it themselves
    const fromEmplio = message.role === "user" && text.startsWith(FROM_EMPLIO);
    return (
      <Fragment key={message.id}>
      {stamp && line(stamp)}
      <Message
        key={message.id}
        id={`m-${message.id}`}
        from={message.role}
        // its buttons hang below it (UserMessageActions) without pushing the reply down
        className={message.role === "user" ? "relative" : undefined}
        data-pin={i === lastUserIdx || undefined}
      >
        {fromEmplio && <span className="self-end text-xs text-muted-foreground">Emplio</span>}
        {message.role === "user" && <MessageAttachments parts={filesOf(message)} />}
        {editing === message.id ? (
          <div className="flex w-full max-w-[80%] flex-col gap-2 self-end rounded-2xl border bg-card p-3">
            <textarea
              autoFocus
              // cursor after the text, ready to go on typing
              onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
              value={editText}
              onChange={(e) => setEditText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(null);
                // Enter is a new line here; on a phone, which has no Command key, only the Send button sends
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void handlers.current.saveEdit(message, i, editText);
                }
              }}
              rows={Math.min(10, editText.split("\n").length + 1)}
              className="w-full resize-none bg-transparent text-[15px] outline-none"
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void handlers.current.saveEdit(message, i, editText)}>
                Send
              </Button>
            </div>
          </div>
        ) : (message.role === "assistant" || text) && (
          <MessageContent className="text-[15px] leading-relaxed group-[.is-user]:rounded-2xl group-[.is-user]:px-4 group-[.is-user]:py-2.5">
            {message.role === "user" ? (
              <LongText>
                <QuotedText text={userFacingText(fromEmplio ? text.slice(FROM_EMPLIO.length) : text)} marks={sentMarks(message)} links={sentLinks(message)} />
              </LongText>
            ) : isLast && busy && message.parts.every((p) => p.type !== "text" && p.type !== "tool-bash") ? (
              thinking(message)
            ) : (
              <>
                <ReplyContext value={messages[i + 1]?.role === "user" ? userFacingText(textOf(messages[i + 1]!)) : undefined}>
                  <AssistantParts
                    message={message}
                    streaming={isLast && status === "streaming"}
                    renderText={(t, streaming) => <AssistantReply text={t.replace("[SILENT]", "").trim()} streaming={streaming} onSend={(t) => handlers.current.send(t)} />}
                  />
                </ReplyContext>
                {isLast && busy && thinking(message)}
              </>
            )}
          </MessageContent>
        )}
        {message.role === "user" && editing !== message.id && (
          <UserMessageActions
            text={userFacingText(text)}
            versions={(message.metadata as Versions | undefined)?.versions ?? []}
            current={message.id}
            // a Telegram thread is answered there, so it isn't edited here either
            disabled={busy || onTelegram}
            onEdit={
              text && !fromEmplio
                ? () => {
                    setEditText(userFacingText(text));
                    setEditing(message.id);
                  }
                : undefined
            }
            onShow={(v) => void handlers.current.showVersion(v)}
          />
        )}
        {message.role === "assistant" && !(isLast && busy) && text && (
          <MessageActions className="-ml-1.5 gap-0.5 text-muted-foreground [&_button]:size-7 [&_svg]:size-3.5! opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
            <CopyButton text={text} />
            {isLast && (
              <MessageAction tooltip="Regenerate" onClick={() => handlers.current.regenerate()}>
                <RefreshCcwIcon />
              </MessageAction>
            )}
          </MessageActions>
        )}
      </Message>
      </Fragment>
    );
  };

  const liveTitle = conversations?.find((c) => c.id === id)?.title ?? title;
  // an old Telegram-only thread is answered there; the main chat is on Telegram and here at once
  const here = conversations?.find((c) => c.id === id);
  const onTelegram = here?.channel === "telegram" && here.kind !== "main";
  const firstName = me?.user.name?.split(" ")[0];

  // for the memoized message list below: its buttons call the latest of these, without redrawing it
  const handlers = useRef({ send, sendText, dispatch, saveEdit, showVersion, regenerate });
  handlers.current = { send, sendText, dispatch, saveEdit, showVersion, regenerate };
  // the same function every render, so the cards that send (connect, ask) aren't drawn again on each key
  const sendLatest = useCallback((text: string) => handlers.current.sendText(text), []);

  // drawn messages, kept while nothing they show changed: while a reply streams only it is drawn again
  const rows = useRef(new WeakMap<UIMessage, { sig: string; node: React.ReactNode }>());
  const row = (m: UIMessage, i: number) => {
    const isLast = i === messages.length - 1;
    // busy only matters to the last message and the prompts' edit buttons: a send doesn't redraw every old reply
    const sig = [i, messages[i - 1]?.id, isLast && status, (isLast || m.role === "user") && busy, editing === m.id && editText, i === lastUserIdx, onTelegram, isLast && summarizing, messages[i + 1]?.id].join("|");
    const kept = rows.current.get(m);
    if (kept?.sig === sig) return kept.node;
    const node = renderMessage(m, i);
    rows.current.set(m, { sig, node });
    return node;
  };

  // Typing re-rendered every message and its buttons (~200ms a key on a long chat): the list is only drawn
  // again when something it shows changes. Its buttons reach for the latest handlers through `handlers`.
  const list = useMemo(
    () =>
      turns.slice(-shown).map((turn, t, visible) => {
        const latest = t === visible.length - 1;
        return (
          <div
            key={turn.key}
            // not content-visibility: heights guessed until scrolled near move the text on iPhones, which don't
            // keep the place when something above changes size (TURNS_SHOWN keeps what's drawn small)
            className="flex flex-col gap-6"
            style={latest && pinLatest ? { minHeight: viewportHeight - PIN_GAP - LIST_PADDING } : undefined}
          >
            {turn.items.map((m, n) => row(m, turn.start + n))}
            {latest && (
              <>
                {busy && messages.at(-1)?.role === "user" && (
                  <Message from="assistant">
                    <MessageContent className="text-[15px] leading-relaxed">{thinking()}</MessageContent>
                  </Message>
                )}

                {error && !reconnecting && (
                  <div className="flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm">
                    <TriangleAlertIcon className="size-4 shrink-0 text-destructive" />
                    <span className="flex-1">{paused ? pausedNote(error.message) : "Something went wrong while generating a reply."}</span>
                    {/* what it did before failing is saved: carry on from there instead of redoing it */}
                    {!paused && messages.at(-1)?.role === "assistant" && (
                      <Button size="sm" variant="outline" onClick={() => handlers.current.dispatch({ text: "Continue", files: [] })}>
                        Continue
                      </Button>
                    )}
                    {!paused && (
                      <Button size="sm" variant={messages.at(-1)?.role === "assistant" ? "ghost" : "outline"} onClick={() => regenerate()}>
                        Try again
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- everything else it reads follows from these
    [id, messages, status, error, reconnecting, paused, editing, editText, summarizing, onTelegram, pinLatest, viewportHeight, shown],
  );

  const composer = (
    <div className="relative">
      {skillMenu.menu ?? mentionMenu.menu}
    <PromptInput
      onSubmit={({ text }) => send(text)}
      className="rounded-2xl shadow-sm transition-shadow focus-within:shadow-md [&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:bg-card [&_[data-slot=input-group]]:ring-0! [&_[data-slot=input-group]]:focus-within:border-foreground/25"
    >
      {(attachments.items.length > 0 || quotes.length > 0) && (
        <PromptInputHeader className="p-0">
          {quotes.length > 0 && <QuoteChips quotes={quotes} onChange={setQuotes} />}
          {attachments.items.length > 0 && <AttachmentTray items={attachments.items} onRemove={attachments.remove} onRetry={attachments.retry} />}
        </PromptInputHeader>
      )}
      <div className="relative w-full">
        <HighlightLayer text={input} marks={marks} />
        <PromptInputTextarea
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
          placeholder={quotes.length > 1 ? "Anything else? (optional)" : busy ? "Queue a follow-up…" : (job ? `Message ${job.agent ?? "Emplio"}…` : "Ask Emplio anything…")}
          // not on phones: the keyboard would cover half the chat the moment it opens
          autoFocus={typeof window !== "undefined" && matchMedia("(pointer: fine)").matches}
          className="px-4 pt-4 text-[15px]"
        />
      </div>
      {/* A press keeps the focus in the box. Losing it brings the phone's tab bar back at once, which moves these
          buttons out from under the finger before it lifts, and the tap is lost. */}
      <PromptInputFooter className="px-3 pb-3" onMouseDown={(e) => e.preventDefault()}>
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
          <PromptInputButton
            tooltip="Attach images, PDFs or text files"
            aria-label="Attach files"
            onClick={() => fileInput.current?.click()}
            className="rounded-full text-muted-foreground"
          >
            <PaperclipIcon className="size-4" />
          </PromptInputButton>
          <VoiceInput onText={(text) => setInput((current) => [current.trim(), text].filter(Boolean).join(" "))} />
          <span className="hidden pl-1 text-xs text-muted-foreground sm:inline">
            <kbd className="font-sans">Enter</kbd> to send ·{" "}
            <kbd className="font-sans">Shift + Enter</kbd> for a new line
          </span>
        </PromptInputTools>
        {/* not `disabled`: the input group fades itself out when anything inside is disabled */}
        {/* while a reply streams: stop when the box is empty, queue when there's something to send */}
        <PromptInputSubmit
          status={busy && !canSend ? status : undefined}
          onStop={stopAll}
          aria-disabled={!busy && !canSend}
          aria-label={busy ? (canSend ? "Queue message" : "Stop") : "Send"}
          className="size-8 rounded-full aria-disabled:opacity-40"
        >
          {busy && !canSend ? undefined : <ArrowUpIcon className="size-4" />}
        </PromptInputSubmit>
      </PromptInputFooter>
    </PromptInput>
    </div>
  );

  return (
    <BrowserProvider value={browser}>
    <OpenFileProvider value={showFile}>
    <ChatSendContext value={sendLatest}>
      <div className="flex min-h-0 flex-1">
        <div className="relative flex h-full min-w-0 flex-1 flex-col" {...dropZone}>
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/90 md:bg-background/80 md:backdrop-blur-sm animate-in fade-in duration-150">
              <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-foreground/20 px-12 py-10 text-center">
                <UploadIcon className="size-6 text-muted-foreground" />
                <div className="font-medium">Drop files to attach</div>
                <div className="text-sm text-muted-foreground">Images, PDFs and text files up to 100 MB</div>
              </div>
            </div>
          )}
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
            <SidebarTrigger />
            {job ? (
              <h1 className="flex min-w-0 items-baseline gap-1.5 px-2 font-sans text-sm font-medium tracking-normal">
                <span className="truncate">{job.agent ?? job.name}</span>
                {job.agent && <span className="truncate font-normal text-muted-foreground">· {job.name}</span>}
              </h1>
            ) : empty || !liveTitle ? (
              <h1 className="truncate px-2 font-sans text-sm font-medium tracking-normal">New chat</h1>
            ) : (
              <EditableTitle id={id} title={liveTitle} />
            )}
            <div className="ml-auto flex items-center gap-2">
              {/* out of the sidebar and back to the main chat; its line there still opens it */}
              {job && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() =>
                    void api(`/jobs/${job.id}/close`, {}).then(() => {
                      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
                      router.push("/home");
                    })
                  }
                >
                  <XIcon />
                  Close
                </Button>
              )}
              {onTelegram && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground"
                  title="This chat is on Telegram; reply there"
                >
                  <SendIcon className="size-3.5 text-[#229ED9]" />
                  Telegram
                </span>
              )}
              <BrowserChip />
            </div>
          </header>

          {empty ? (
            <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 pb-[10vh]">
              <div className="w-full max-w-2xl">
                <h2 className="mb-2 text-center text-3xl font-semibold sm:text-4xl">
                  {greeting()}, {firstName}
                </h2>
                <p className="mb-8 text-center text-muted-foreground">What can I take off your plate today?</p>
                {composer}
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <Suggestion key={s} suggestion={s} onClick={send} className="bg-card text-muted-foreground" />
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="relative flex min-h-0 flex-1 flex-col">
                <div
                  ref={scrollRef}
                  onScroll={() => {
                    lastScroll.current = Date.now();
                    checkBottom();
                  }}
                  // their own scrolling ends the hold on a just-sent prompt
                  onWheel={() => (pinnedAt.current = 0)}
                  onTouchStart={() => (pinnedAt.current = 0)}
                  role="log"
                  className="relative flex-1 overflow-y-auto"
                >
                  <QuoteButton
                    area={scrollRef}
                    onQuote={(text) => {
                      const next = addQuote(quotes, text);
                      // the second quote: what was typed answered the first, so it moves into the first's own box
                      // drawn now, not on the next frame: a phone only brings up its keyboard for a field focused during the tap
                      flushSync(() => {
                        if (quotes.length === 1 && next.length === 2 && input.trim()) {
                          next[0] = { ...next[0]!, note: input };
                          setInput("");
                        }
                        setQuotes(next);
                      });
                      // into its own answer box from two on, else the message box, with the caret at the end of what's typed
                      const box =
                        next.length > 1
                          ? document.querySelector<HTMLTextAreaElement>(`textarea[data-quote-note="${next.findIndex((q) => q.text === text)}"]`)
                          : document.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
                      box?.focus();
                      box?.setSelectionRange(box.value.length, box.value.length);
                    }}
                  />
                  <div ref={contentRef} className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8" style={cardRoom ? { paddingBottom: cardRoom + 32 } : undefined}>
                    {list}
                  </div>
                </div>
                {!atBottom && (
                  <Button
                    size="icon"
                    variant="secondary"
                    aria-label="Scroll to bottom"
                    onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })}
                    style={cardRoom ? { bottom: cardRoom + 16 } : undefined}
                    className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border shadow-lg"
                  >
                    <ArrowDownIcon className="size-4" />
                  </Button>
                )}
              </div>
              <div className="relative mx-auto w-full max-w-3xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))] max-md:pb-3">
                {queue.length > 0 && (
                  <QueuePanel
                    queue={queue}
                    paused={status === "error" && !reconnecting}
                    onEdit={editQueued}
                    onRemove={(item) => {
                      unsteer(item);
                      setQueue((q) => q.filter((x) => x.id !== item.id));
                    }}
                    onSendNow={busy ? sendNow : undefined}
                  />
                )}
                {nextStep && !input && !attachments.items.length && !quotes.length && !busy && !queue.length && !onTelegram && (
                  <div ref={(card) => void (card && setCardRoom(card.offsetHeight))} className="absolute inset-x-4 bottom-full z-20 pb-2">
                    <NextStepCard card={nextStep} onAnswer={answerNextStep} onClose={closeNextStep} />
                  </div>
                )}
                {onTelegram ? <TelegramOnly /> : composer}
              </div>
            </>
          )}
        </div>
        <BrowserPanel />
        <FilePanel file={browser.open ? null : openFile} onClose={() => setOpenFile(null)} />
      </div>
    </ChatSendContext>
    </OpenFileProvider>
    </BrowserProvider>
  );
}

function QueuePanel({
  queue,
  paused,
  onEdit,
  onRemove,
  onSendNow,
}: {
  queue: Queued[];
  paused: boolean;
  onEdit: (item: Queued) => void;
  onRemove: (item: Queued) => void;
  onSendNow?: (item: Queued) => void;
}) {
  return (
    <div className="mx-3 rounded-t-xl border border-b-0 bg-muted/50 px-1.5 pt-1.5 pb-1 animate-in fade-in slide-in-from-bottom-1 duration-150">
      <div className="px-2 pt-0.5 pb-1 text-xs text-muted-foreground">
        {paused ? "Paused · press Continue or Try again to send these" : "Queued · sent after the current step"}
      </div>
      <ul>
        {queue.map((item) => (
          <li
            key={item.id}
            className="group/q flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-background/60 animate-in fade-in duration-150"
          >
            <CornerDownRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {item.text || <span className="text-muted-foreground">No message</span>}
            </span>
            {item.files.length > 0 && (
              <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <PaperclipIcon className="size-3" />
                {item.files.length}
              </span>
            )}
            <span className="flex shrink-0 gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/q:opacity-100 sm:focus-within:opacity-100">
              <Button size="icon-xs" variant="ghost" aria-label="Edit queued message" onClick={() => onEdit(item)}>
                <PencilIcon />
              </Button>
              {onSendNow && (
                <Button size="icon-xs" variant="ghost" aria-label="Send now" title="Send now (stops the current reply)" onClick={() => onSendNow(item)}>
                  <ArrowUpIcon />
                </Button>
              )}
              <Button size="icon-xs" variant="ghost" aria-label="Remove queued message" onClick={() => onRemove(item)}>
                <XIcon />
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EditableTitle({ id, title }: { id: string; title: string }) {
  const [editing, setEditing] = useState(false);
  const rename = useRenameConversation();
  // the title it opened with shows as is; one that changes after (the AI's title replacing the first message) writes itself in
  const [opened] = useState(title);

  if (editing)
    return (
      <RenameInput
        initial={title}
        className="h-8 w-full max-w-md rounded-md border bg-background px-2 text-sm font-medium"
        onDone={(next) => {
          setEditing(false);
          if (next && next !== title) rename.mutate({ id, title: next });
        }}
      />
    );

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Rename chat"
      className="group/title flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm font-medium hover:bg-muted"
    >
      <h1
        key={title}
        className={cn("truncate font-sans tracking-normal", title !== opened && "type-in")}
        style={{ "--type-len": title.length } as React.CSSProperties}
      >
        {title}
      </h1>
      <PencilIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-visible/title:opacity-100 pointer-coarse:opacity-60" />
    </button>
  );
}

// A long sent message folds to its first lines; "Show more" opens it.
function LongText({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [children, open]);
  return (
    <>
      <p ref={ref} className={cn("whitespace-pre-wrap", !open && "line-clamp-8")}>
        {children}
      </p>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-sm font-medium text-muted-foreground hover:text-foreground">
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <MessageAction
      tooltip={copied ? "Copied" : "Copy"}
      onClick={async (e) => {
        // copy what the user sees (generated UI has no readable source text)
        const reply = e.currentTarget.closest(".group")?.querySelector<HTMLElement>("[data-reply]");
        await copyText(reply?.innerText.trim() || text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }, () => {});
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </MessageAction>
  );
}

// Under a sent message: edit it (forks the chat), and with several versions, "‹ 2 / 3 ›" to switch between them.
function UserMessageActions({
  text,
  versions,
  current,
  disabled,
  onEdit,
  onShow,
}: {
  text: string;
  versions: string[];
  current: string;
  disabled: boolean;
  onEdit?: () => void;
  onShow: (id: string) => void;
}) {
  const at = versions.indexOf(current);
  return (
    <MessageActions className="absolute top-full right-0 gap-0.5 text-muted-foreground pointer-coarse:static pointer-coarse:self-end has-[[data-versions]]:static has-[[data-versions]]:self-end [&_button]:size-7 [&_svg]:size-3.5! opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 has-[[data-versions]]:opacity-100">
      {text && <CopyButton text={text} />}
      {onEdit && !disabled && (
        <MessageAction tooltip="Edit" onClick={onEdit}>
          {/* drawn heavier than the copy icon at the same size */}
          <PencilIcon className="size-3!" />
        </MessageAction>
      )}
      {versions.length > 1 && at >= 0 && (
        <span data-versions className="flex items-center text-xs tabular-nums">
          <MessageAction tooltip="Previous version" disabled={disabled || at === 0} onClick={() => onShow(versions[at - 1]!)}>
            <ChevronLeftIcon />
          </MessageAction>
          {at + 1} / {versions.length}
          <MessageAction tooltip="Next version" disabled={disabled || at === versions.length - 1} onClick={() => onShow(versions[at + 1]!)}>
            <ChevronRightIcon />
          </MessageAction>
        </span>
      )}
    </MessageActions>
  );
}

// A Telegram thread is read here, answered there: what's typed on the web wouldn't reach Telegram.
function TelegramOnly() {
  const { data } = useQuery({ queryKey: channelsQueryKey, queryFn: () => api<Channels>("/channels") });
  // the bot itself, without the one-time link code
  const bot = data?.telegram.url?.split("?")[0];
  return (
    <div className="flex items-center gap-3 rounded-2xl border bg-card px-4 py-3 text-sm shadow-sm">
      <SendIcon className="size-4 shrink-0 text-[#229ED9]" />
      <span className="min-w-0 flex-1 text-muted-foreground">This chat lives in Telegram. Reply there.</span>
      {bot && (
        <Button size="sm" variant="outline" className="shrink-0 rounded-full" nativeButton={false} render={<a href={bot} target="_blank" rel="noreferrer" />}>
          Open Telegram
        </Button>
      )}
    </div>
  );
}

// "2:05 pm" today, "Yesterday, 2:05 pm", then "Mon 26 Oct, 2:05 pm"
function when(d: Date) {
  const t = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return t;
  if (days === 1) return `Yesterday, ${t}`;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${t}`;
}

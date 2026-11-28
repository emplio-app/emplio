import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Client, ClientField, FieldKind, ClientPage, ClientStage, Contact, ConversationSummary, HistoryEntry, MeResponse, Process, ProcessRun, Project, Service, Task } from "@emplio/shared";
import { WebSocketChatTransport } from "ai";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window === "undefined"
    ? "http://localhost:4000"
    : window.location.port
      ? // ponytail: same host as the page so phones on the wifi reach the backend
        `http://${window.location.hostname}:4000`
      : // a self-hosted install on its own web address: its proxy serves the API under /api
        `${window.location.origin}/api`);

export async function api<T>(
  path: string,
  body?: unknown,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = body === undefined ? "GET" : "POST",
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? data.message ?? "Something went wrong"), { match: data.match as Match | undefined });
  return data as T;
}
// a record a new one looks like (backend records.ts Match): the app offers to open it, or add anyway
export type Match = { slug: string; name: string; archived: boolean };
export const matchIn = (e: unknown) => (e as { match?: Match } | null)?.match;
// a change refused because someone changed it after it was read (backend records.ts stale): shown, then the latest
export const isStale = (e: unknown) => /after you read it/.test((e as Error | null)?.message ?? "");

export const meQueryKey = ["me"];
export const conversationsQueryKey = ["conversations"];
export const tasksQueryKey = ["tasks"];
// every record list and page (clients, contacts, projects, services, stages, fields) sits under this, so a change
// to one refreshes them all: a project's change shows on its client's page
export const recordsQueryKey = ["records"];
export const clientsQueryKey = ["records", "clients"];
// each chat's Allow cards (approval-card.tsx), under ["approvals", chat id]
export const approvalsQueryKey = ["approvals"];
export const versionQueryKey = ["version"];

// The business's clients (backend clients.ts), for the Clients page and the task pickers.
export function useClients() {
  return useQuery({ queryKey: clientsQueryKey, queryFn: () => api<Client[]>("/clients") });
}

// The business's processes (backend processes.ts) and their runs: the Processes page and a client's panel.
export const processesQueryKey = ["processes"];
export const processRunsQueryKey = ["process-runs"];
export function useProcesses() {
  return useQuery({ queryKey: processesQueryKey, queryFn: () => api<Process[]>("/processes") });
}
const list = (f: Record<string, string | boolean | undefined>) => {
  const q = new URLSearchParams(Object.entries(f).flatMap(([k, v]) => (v ? [[k, v === true ? "1" : v]] : [])));
  return q.size ? `?${q}` : "";
};
// Everything about one client: its contacts, projects, open work, runs, meetings, notes and history
export function useClientPage(slug: string) {
  return useQuery({ queryKey: [...recordsQueryKey, "client", slug], queryFn: () => api<ClientPage>(`/clients/${encodeURIComponent(slug)}/page`) });
}
export function useArchivedClients(enabled: boolean) {
  return useQuery({ queryKey: [...clientsQueryKey, "archived"], queryFn: () => api<Client[]>("/clients?archived=1"), enabled });
}
export function useStages() {
  return useQuery({ queryKey: [...recordsQueryKey, "stages"], queryFn: () => api<ClientStage[]>("/client-stages") });
}
// the business's own fields on one kind of record
export function useFields(kind: FieldKind = "client") {
  return useQuery({ queryKey: [...recordsQueryKey, "fields", kind], queryFn: () => api<ClientField[]>(`/fields/${kind}`) });
}
export function useContacts(f: { client?: string; archived?: boolean } = {}) {
  return useQuery({ queryKey: [...recordsQueryKey, "contacts", f], queryFn: () => api<Contact[]>(`/contacts${list(f)}`) });
}
export function useProjects(f: { client?: string; archived?: boolean; all?: boolean } = {}) {
  return useQuery({ queryKey: [...recordsQueryKey, "projects", f], queryFn: () => api<Project[]>(`/projects${list(f)}`) });
}
export function useServices(f: { archived?: boolean } = {}) {
  return useQuery({ queryKey: [...recordsQueryKey, "services", f], queryFn: () => api<Service[]>(`/services${list(f)}`) });
}
// one contact, project or service with its history (and a project's tasks)
export function useRecord<T>(kind: "contacts" | "projects" | "services", slug: string | null) {
  return useQuery({
    queryKey: [...recordsQueryKey, kind, "one", slug],
    queryFn: () => api<T & { history: HistoryEntry[] }>(`/${kind}/${encodeURIComponent(slug!)}`),
    enabled: !!slug,
  });
}
// a change to any record: refetch every record list and page, and the tasks (a project's move takes its tasks along)
// silent: the caller shows the error (an add form offering the close match)
const SAVE_FAILED = "emplio:save-failed";
// A field's own copy of a saved value: follows the saved one, and goes back to it when a save is refused
export function useSaved(value: string) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    const back = () => setV(value);
    window.addEventListener(SAVE_FAILED, back);
    return () => window.removeEventListener(SAVE_FAILED, back);
  }, [value]);
  return [v, setV] as const;
}
export function useSaveRecord<In, Out = unknown>(fn: (input: In) => Promise<Out>, o: { done?: (out: Out) => void; silent?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (out) => o.done?.(out),
    onError: (e) => {
      // a field left showing what was refused goes back to what's saved (useSaved)
      window.dispatchEvent(new Event(SAVE_FAILED));
      if (!o.silent) toast.error(isStale(e) ? `${e.message.split(" at ")[0]} just now. Here's the latest; make your change again.` : e.message.replace(/^./, (c) => c.toUpperCase()));
    },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: recordsQueryKey }), qc.invalidateQueries({ queryKey: tasksQueryKey }), qc.invalidateQueries({ queryKey: processRunsQueryKey })]),
  });
}
export function useProcessRuns(f: { process?: string; client?: string; all?: boolean } = {}) {
  const q = new URLSearchParams({ ...(f.process && { process: f.process }), ...(f.client && { client: f.client }), ...(f.all && { all: "1" }) });
  return useQuery({ queryKey: [...processRunsQueryKey, f], queryFn: () => api<ProcessRun[]>(`/process-runs?${q}`) });
}

// Every task this person may see (owner and admins: all), for the Tasks page and the sidebar's count.
export function useTasks() {
  return useQuery({
    queryKey: tasksQueryKey,
    queryFn: () => api<Task[]>("/tasks"),
    // while the AI works on one, so it moves to done (or waiting) by itself
    refetchInterval: (q) => (q.state.data?.some((t) => !t.assigneeId && t.status === "doing") ? 5000 : false),
  });
}

// who /auth/me last said is signed in (null: nobody); undefined until it first answers
let signedInAs: string | null | undefined;

export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: async () => {
      // 401 = logged out, not an error
      const me = await api<MeResponse>("/auth/me").catch(() => null);
      // Signed out and back in (as anyone) without a page load: the open chat connection still carries the old,
      // deleted sign-in, so every message would fail. Drop it; the next message opens one with the new sign-in.
      const id = me?.user.id ?? null;
      if (id && signedInAs !== undefined && signedInAs !== id) chatTransport.close();
      signedInAs = id;
      return me;
    },
  });
}

export function useRenameConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api(`/conversations/${id}`, { title }, "PATCH"),
    // update the sidebar and top bar instantly
    onMutate: ({ id, title }) =>
      queryClient.setQueryData<ConversationSummary[]>(conversationsQueryKey, (old) =>
        old?.map((c) => (c.id === id ? { ...c, title } : c)),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: conversationsQueryKey }),
  });
}

// out of the list or back in; nothing is deleted, and anything new in the chat brings it back by itself
export function useArchiveConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => api(`/conversations/${id}`, { archived }, "PATCH"),
    onMutate: ({ id, archived }) => {
      const title = queryClient.getQueryData<ConversationSummary[]>(conversationsQueryKey)?.find((c) => c.id === id)?.title;
      queryClient.setQueryData<ConversationSummary[]>(conversationsQueryKey, (old) => old?.map((c) => (c.id === id ? { ...c, archived } : c)));
      // a few seconds to take it back, like marking a task done. Straight to the server, not through this hook: the chat's own
      // Done button has left the page by then, and a mutation from an unmounted page never runs
      const undo = () =>
        void api(`/conversations/${id}`, { archived: false }, "PATCH").then(() => queryClient.invalidateQueries({ queryKey: conversationsQueryKey }));
      if (archived) toast("Marked done", { description: title, action: { label: "Undo", onClick: undo } });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: conversationsQueryKey }),
  });
}

export function useConversations() {
  return useQuery({
    queryKey: conversationsQueryKey,
    queryFn: () => api<ConversationSummary[]>("/conversations"),
  });
}

// Every chat talks over one shared connection (the server's /chat/ws): replies stream in on it, and opening a
// chat whose reply is still being written replays it and follows it live.
export const chatTransport = new WebSocketChatTransport({
  url: `${API_URL}/chat/ws`,
  // the server loads history itself; only send what's new
  prepareSendMessagesRequest: ({ messages }) => ({ messages: messages.slice(-1) }),
});

// The server's nudges (/events): refetch the lists it says changed (a reply started or finished, a new title, an OK
// card), so the sidebar's working and unread marks stay current. Reconnects after a drop.
// Also the notification center's spot in the app (backend push.ts): we tell the server which page is in front of the
// person, and while one is, their notifications show here instead of on their devices.
export function useLiveEvents() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const tell = useRef(() => {});
  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    // The lists the server can change without this app asking (jobs' chats aren't in the chat list: theirs is the
    // jobs list). Only those named as changed are fetched again: every nudge used to fetch them all. Nudges close
    // together (a reply starting, then its title) come as one fetch each.
    const keys = { chats: conversationsQueryKey, jobs: ["jobs"], tasks: tasksQueryKey, approvals: approvalsQueryKey };
    type Changed = keyof typeof keys;
    const due = new Set<Changed>();
    let soon: ReturnType<typeof setTimeout> | undefined;
    const refresh = (what: Changed[] = Object.keys(keys) as Changed[]) => {
      for (const w of what) if (w in keys) due.add(w);
      clearTimeout(soon);
      soon = setTimeout(() => {
        for (const w of due) void queryClient.invalidateQueries({ queryKey: keys[w] });
        due.clear();
      }, 100);
    };
    const connect = () => {
      socket = new WebSocket(`${API_URL.replace(/^http/, "ws")}/events`);
      // anything missed while disconnected
      socket.onopen = () => {
        refresh();
        tell.current();
        // the connection also drops when a new version goes live
        void queryClient.invalidateQueries({ queryKey: versionQueryKey });
      };
      socket.onmessage = (e) => {
        const frame = JSON.parse(e.data as string) as { type: string; what?: Changed[]; body?: string; path?: string };
        if (frame.type === "changed") refresh(frame.what);
        // a server from before "changed" said only that something did
        else if (frame.type === "chats") refresh();
        if (frame.type === "note" && frame.body && frame.path) {
          const path = frame.path;
          // a long reply would cover the chat: 4 lines, then cut
          toast(frame.body, { duration: 8000, classNames: { title: "line-clamp-4" }, action: { label: "Open", onClick: () => router.push(path) } });
        }
      };
      socket.onclose = () => {
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };
    // in front of them: the page is showing and its window has focus (a background tab, a hidden Mac window or a
    // phone app in the background isn't)
    tell.current = () => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      const looking = document.visibilityState === "visible" && document.hasFocus() ? location.pathname : null;
      socket.send(JSON.stringify({ looking }));
    };
    const told = () => tell.current();
    window.addEventListener("focus", told);
    window.addEventListener("blur", told);
    document.addEventListener("visibilitychange", told);
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(soon);
      socket?.close();
      window.removeEventListener("focus", told);
      window.removeEventListener("blur", told);
      document.removeEventListener("visibilitychange", told);
    };
  }, [queryClient, router]);
  // a different page in front of them
  useEffect(() => tell.current(), [pathname]);
}

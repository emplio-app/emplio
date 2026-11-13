import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationSummary, MeResponse, Task } from "@emplio/shared";
import { WebSocketChatTransport } from "ai";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
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
  if (!res.ok) throw new Error(data.error ?? data.message ?? "Something went wrong");
  return data as T;
}

export const meQueryKey = ["me"];
export const conversationsQueryKey = ["conversations"];
export const tasksQueryKey = ["tasks"];
// each chat's Allow cards (approval-card.tsx), under ["approvals", chat id]
export const approvalsQueryKey = ["approvals"];
export const versionQueryKey = ["version"];

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

// The server's nudges (/events): refetch the chat list when it changed (a reply started or finished, a new
// title), so the sidebar's working and unread marks stay current. Reconnects after a drop.
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
    // a reply that ended may have added or finished tasks too; a card asked or answered nudges as well
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: conversationsQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      void queryClient.invalidateQueries({ queryKey: approvalsQueryKey });
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
        refresh();
        const frame = JSON.parse(e.data as string) as { type: string; body?: string; path?: string };
        if (frame.type === "note" && frame.body && frame.path) {
          const path = frame.path;
          toast(frame.body, { duration: 8000, action: { label: "Open", onClick: () => router.push(path) } });
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
      socket?.close();
      window.removeEventListener("focus", told);
      window.removeEventListener("blur", told);
      document.removeEventListener("visibilitychange", told);
    };
  }, [queryClient, router]);
  // a different page in front of them
  useEffect(() => tell.current(), [pathname]);
}

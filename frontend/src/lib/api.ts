import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationSummary, MeResponse, Task } from "@emplio/shared";
import { WebSocketChatTransport } from "ai";
import { useEffect } from "react";

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

export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    // 401 = logged out, not an error
    queryFn: () => api<MeResponse>("/auth/me").catch(() => null),
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
    onMutate: ({ id, archived }) =>
      queryClient.setQueryData<ConversationSummary[]>(conversationsQueryKey, (old) => old?.map((c) => (c.id === id ? { ...c, archived } : c))),
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
export function useLiveEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    // a reply that ended may have added or finished tasks too
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: conversationsQueryKey });
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    };
    const connect = () => {
      socket = new WebSocket(`${API_URL.replace(/^http/, "ws")}/events`);
      // anything missed while disconnected
      socket.onopen = () => {
        refresh();
        // the connection also drops when a new version goes live
        void queryClient.invalidateQueries({ queryKey: versionQueryKey });
      };
      socket.onmessage = refresh;
      socket.onclose = () => {
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [queryClient]);
}

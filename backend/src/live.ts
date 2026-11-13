import type { UIMessageChunk, WebSocketChatTransportResponse } from "ai";
import type { WebSocket } from "@fastify/websocket";

// What the open apps see as it happens, over WebSockets (routes in chat.ts):
//  - replies: each running reply's chunks are kept until it's saved, so anyone opening that chat (after
//    switching chats, in another tab, on their phone, after a reload) gets it replayed and then follows it live;
//  - events: a nudge to each of a person's open apps when their chat list changes (a reply started or
//    finished, a title was written), so the sidebar's working and unread marks stay current; and a notification
//    (push.ts) shown inside the app they're looking at, which tells us here what that is.
// ponytail: in this process's memory; with more than one server, move both to Redis pub/sub

type Watcher = { socket: WebSocket; requestId: string };
type Reply = { userId: string; chunks: UIMessageChunk[]; watchers: Set<Watcher>; ended: boolean };

const replies = new Map<string, Reply>();
// each open app, and the page it shows while it's in front of them (visible and focused); null when it isn't
const apps = new Map<string, Map<WebSocket, string | null>>();

type Note = { title: string; body: string; path: string };
export const send = (socket: WebSocket, frame: WebSocketChatTransportResponse | { type: "chats" } | ({ type: "note" } & Note)) => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
};

// A reply has started in conversation `id`: keep its chunks and pass each to whoever is watching.
export function follow(id: string, userId: string, stream: ReadableStream<UIMessageChunk>) {
  const reply: Reply = { userId, chunks: [], watchers: new Set(), ended: false };
  replies.set(id, reply);
  void (async () => {
    try {
      for await (const chunk of stream) {
        const sequence = reply.chunks.push(chunk) - 1;
        for (const w of reply.watchers) send(w.socket, { type: "chunk", requestId: w.requestId, sequence, chunk });
      }
      for (const w of reply.watchers) send(w.socket, { type: "end", requestId: w.requestId });
    } catch (error) {
      for (const w of reply.watchers) send(w.socket, { type: "error", requestId: w.requestId, errorText: String(error) });
    }
    reply.ended = true;
    reply.watchers.clear();
  })();
  notify(userId);
  return reply;
}

// The reply is saved: from here the chat loads from the database.
export function settle(id: string, reply: Reply) {
  if (replies.get(id) === reply) replies.delete(id);
  notify(reply.userId);
}

export const isReplying = (id: string) => replies.has(id);
export const isWatched = (id: string) => !!replies.get(id)?.watchers.size;

// Replay the reply so far to `w`, then keep it following. False when there's no reply to follow.
export function watch(id: string, w: Watcher) {
  const reply = replies.get(id);
  if (!reply) return false;
  reply.chunks.forEach((chunk, sequence) => send(w.socket, { type: "chunk", requestId: w.requestId, sequence, chunk }));
  if (reply.ended) send(w.socket, { type: "end", requestId: w.requestId });
  else reply.watchers.add(w);
  return true;
}

// Stop sending to a watcher (it hung up, switched chats or pressed Stop); the reply goes on.
export function unwatch(match: (w: Watcher) => boolean) {
  for (const reply of replies.values()) for (const w of reply.watchers) if (match(w)) reply.watchers.delete(w);
}

// --- events ---

export function addApp(userId: string, socket: WebSocket) {
  const sockets = apps.get(userId) ?? new Map<WebSocket, string | null>();
  apps.set(userId, sockets.set(socket, null));
  // the app says what's in front of them: { looking: "/chat/…" }, or { looking: null } once it's in the background
  socket.on("message", (data: Buffer) => {
    try {
      const { looking } = JSON.parse(data.toString()) as { looking?: unknown };
      sockets.set(socket, typeof looking === "string" && looking.startsWith("/") ? looking.slice(0, 300) : null);
    } catch {}
  });
  socket.on("close", () => {
    sockets.delete(socket);
    if (!sockets.size && apps.get(userId) === sockets) apps.delete(userId);
  });
}

// This person's chat list changed: their open apps fetch it again.
export function notify(userId: string) {
  for (const socket of apps.get(userId)?.keys() ?? []) send(socket, { type: "chats" });
}

// A notification, inside the app they're looking at right now. False when there's none, so it goes to their devices
// instead (push.ts); true when it's shown, or they're on that very chat and see it arrive anyway.
export function showInApp(userId: string, note: Note) {
  const looking = [...(apps.get(userId) ?? [])].filter(([, page]) => page);
  for (const [socket, page] of looking) if (page !== note.path) send(socket, { type: "note", ...note });
  return looking.length > 0;
}

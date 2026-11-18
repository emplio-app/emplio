"use client";

import type { Task } from "@emplio/shared";
import { useQueryClient } from "@tanstack/react-query";
import { AlarmClockIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { api, tasksQueryKey, useTasks } from "@/lib/api";

// When Emplio comes back to this chat next (its own task, waiting to wake up here): change it on the Tasks page, or cancel it.
export function NextCheck({ chatId }: { chatId: string }) {
  const queryClient = useQueryClient();
  const { data } = useTasks();
  const next = data
    ?.filter((t) => !t.assigneeId && t.status === "todo" && t.dueAt && (t.workConversationId === chatId || t.conversationId === chatId))
    .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))[0];
  if (!next) return null;
  const cancel = () => {
    queryClient.setQueryData<Task[]>(tasksQueryKey, (old) => old?.map((t) => (t.id === next.id ? { ...t, status: "cancelled" } : t)));
    void api(`/tasks/${next.id}`, { status: "cancelled" }, "PATCH").finally(() => queryClient.invalidateQueries({ queryKey: tasksQueryKey }));
  };
  const at = new Date(next.dueAt!).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  return (
    <div className="mb-2 flex min-w-0 items-center rounded-lg border bg-card text-xs text-muted-foreground">
      <Link href={`/tasks?task=${next.id}`} title={`${next.title}: change when`} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 hover:text-foreground">
        <AlarmClockIcon className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium text-foreground">Next check: {at}</span>
        <span className="min-w-0 flex-1 truncate">· {next.title}</span>
      </Link>
      <button type="button" aria-label="Cancel the next check" title="Cancel" onClick={cancel} className="mr-1 grid size-6 shrink-0 place-items-center rounded-md hover:bg-muted hover:text-foreground">
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

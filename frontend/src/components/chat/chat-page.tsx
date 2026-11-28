"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatJob } from "@emplio/shared";
import type { UIMessage } from "ai";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { useDraft } from "@/components/chat/draft";
import { ChatView } from "@/components/chat/chat-view";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { api, takeChatEarly } from "@/lib/api";

// job: a job's own chat (opening it puts it in the sidebar, under Chat)
type ConversationResponse = { id: string; title: string; messages: UIMessage[]; older: string | null; job?: ChatJob };

export function ChatPage() {
  const { id } = useParams<{ id?: string[] }>();
  const { draftId, newDraft } = useDraft();
  const conversationId = id?.[0];

  // Opening another chat retires the draft: once sent it's a saved conversation, and coming back
  // to it must load it from the server, not show the empty new-chat screen.
  useEffect(() => {
    if (conversationId && conversationId !== draftId) newDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the open chat changes
  }, [conversationId]);
  // The draft chat updates the URL itself after the first send; it's already live, don't refetch it.
  const isDraft = !conversationId || conversationId === draftId;

  const { data, error } = useQuery({
    queryKey: ["conversation", conversationId],
    // opened from a search result: all of it, so the message is there to show
    queryFn: () =>
      location.hash.startsWith("#m-")
        ? api<ConversationResponse>(`/conversations/${conversationId}?limit=5000`)
        : takeChatEarly(conversationId!, () => api<ConversationResponse>(`/conversations/${conversationId}`)),
    enabled: !isDraft,
    staleTime: 0,
    gcTime: 0,
  });

  // opening a job's chat put it in the sidebar, under Chat
  const queryClient = useQueryClient();
  const jobId = data?.job?.id;
  useEffect(() => {
    if (jobId) void queryClient.invalidateQueries({ queryKey: ["jobs"] });
  }, [jobId, queryClient]);

  if (isDraft) return <ChatView key={draftId} id={draftId} initialMessages={[]} isNew />;

  if (error)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="font-heading text-lg font-semibold">Conversation not found</p>
        <p className="text-sm text-muted-foreground">It may have been deleted.</p>
        <Button variant="outline" nativeButton={false} render={<Link href="/home" />}>
          Back to Home
        </Button>
      </div>
    );

  if (!data)
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Spinner />
      </div>
    );

  return <ChatView key={data.id} id={data.id} title={data.title} initialMessages={data.messages} initialOlder={data.older} job={data.job} />;
}

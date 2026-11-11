"use client";

import type { SlashCommand } from "@emplio/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SparklesIcon, ZapIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, useEffect, useState } from "react";
import { AppLogo } from "@/components/chat/connect-card";
import { cached, instant, MenuSkeleton, SearchingMore } from "@/components/chat/mention-menu";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

// Typing "/" at the start of a message offers the business's skills (and the person's own): pick one and the
// message starts with /name, which the server answers with that skill (backend/src/skills.ts). Automations
// are offered too: picking one runs it now and opens its chat. So are apps (/github): the agent is told to
// use that app. Searched on the server as they type (GET /commands), a few of each kind.
const commandQuery = (q: string) => ({
  queryKey: ["commands", q],
  queryFn: () => api<SlashCommand[]>(`/commands?q=${encodeURIComponent(q)}`),
  staleTime: 15_000,
});

export function useSkillMenu(input: string, setInput: (text: string) => void) {
  const router = useRouter();
  const run = useMutation({
    mutationFn: (name: string) => api<{ conversationId: string | null }>(`/automations/${name}/run`, undefined, "POST"),
    onSuccess: ({ conversationId }) => conversationId && router.push(`/chat/${conversationId}`),
  });
  const [active, setActive] = useState(0);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  // skills and apps picked from the menu: their /name at the start of the text is coloured in and sent with it
  const [picked, setPicked] = useState<string[]>([]);
  const typed = /^\/([\w.-]*)$/.exec(input)?.[1];
  const open = typed !== undefined && closedFor !== input;

  // what a bare / shows is fetched as the page opens, so it's there the moment / is typed
  const queryClient = useQueryClient();
  useEffect(() => void queryClient.prefetchQuery(commandQuery("")), [queryClient]);
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(typed ?? ""), 120);
    return () => clearTimeout(t);
  }, [typed]);
  useQuery({ ...commandQuery(debounced), enabled: open, placeholderData: keepPreviousData });
  const key = (c: SlashCommand) => `${c.kind}/${c.name}`;
  const found = instant<SlashCommand>(queryClient, "commands", typed ?? "", {
    key,
    name: (c) => c.name,
    more: (c) => c.description,
    group: (c) => ["skill", "automation", "app"].indexOf(c.kind),
    per: 5,
    first: (c) => (c.kind === "skill" ? c.scope === "me" : c.kind === "app" && c.connected),
  });
  const matches = open ? found.items : [];
  const at = Math.min(active, Math.max(matches.length - 1, 0));
  const pick = (s: SlashCommand) => {
    setActive(0);
    if (s.kind !== "automation") {
      setPicked((p) => [...new Set([...p, s.name])]);
      return setInput(`/${s.name} `);
    }
    setInput("");
    run.mutate(s.name);
  };
  // typed out in full (no pick) counts too once they've gone on past it (a space), not while still typing it
  const name = /^\/([\w.-]+)(?=\s)/.exec(input)?.[1];
  const command = name && (picked.includes(name) || cached(queryClient, "commands", key).some((d) => d.kind !== "automation" && d.name === name)) ? name : undefined;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!matches.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((at + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
    } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      pick(matches[at]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setClosedFor(input);
    }
  };

  const menu = matches.length ? (
    <div
      role="listbox"
      aria-label="Skills"
      className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {matches.map((s, i) => (
        <button
          key={`${s.kind === "skill" ? s.scope : s.kind}/${s.name}`}
          type="button"
          role="option"
          aria-selected={i === at}
          // keep the message box focused
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setActive(i)}
          onClick={() => pick(s)}
          className={cn("flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left", i === at && "bg-accent")}
        >
          {s.kind === "skill" ? (
            <SparklesIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : s.kind === "app" ? (
            <AppLogo src={s.logo} className="size-5" />
          ) : (
            <ZapIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              /{s.name}
              {s.kind === "skill" && s.scope === "me" && <span className="rounded bg-muted px-1 text-[0.65rem] font-normal text-muted-foreground">yours</span>}
            </span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{s.description}</span>
          </span>
        </button>
      ))}
      {!found.final && <SearchingMore />}
    </div>
  ) : open && !found.final ? (
    <MenuSkeleton />
  ) : run.isPending || (run.error && !input) ? (
    <div className={cn("absolute inset-x-0 bottom-full mb-2 rounded-xl border bg-popover px-3 py-2 text-sm shadow-md", run.error && "text-destructive")}>
      {run.error ? `Couldn't run it: ${run.error.message}` : `Starting ${run.variables}…`}
    </div>
  ) : null;

  return { menu, onKeyDown, command };
}

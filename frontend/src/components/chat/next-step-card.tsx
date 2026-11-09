"use client";

import type { NextStep } from "@emplio/shared";
import { CommandIcon, CornerDownLeftIcon, XIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

const KEY = "size-6 rounded-[6px] border border-background/20 bg-transparent text-background";

// Places with their own Cmd+Enter or typing of their own (editing a message, a note on a quote, an open window)
const NOT_FOR_THE_CARD = '[role="dialog"], [role="alertdialog"], input, textarea:not([name="message"]), [contenteditable="true"]';

// After a reply: where things stand, the question that moves the work on, and answers to tap (backend chat.ts nextStep).
// Cmd/Ctrl+Enter takes the first answer.
export function NextStepCard({ card, onAnswer, onClose }: { card: NextStep; onAnswer: (button: string) => void; onClose: () => void }) {
  useEffect(() => {
    const press = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.repeat || e.isComposing) return;
      if ((e.target as Element).closest?.(NOT_FOR_THE_CARD)) return;
      e.preventDefault();
      // before the chat box sees it, which would try to send what's in the box
      e.stopPropagation();
      onAnswer(card.buttons[0]!);
    };
    window.addEventListener("keydown", press, true);
    return () => window.removeEventListener("keydown", press, true);
  }, [card, onAnswer]);

  return (
    <Card size="sm" className="relative mb-2 gap-2 px-3 animate-in fade-in slide-in-from-bottom-1 duration-200">
      <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={onClose} className="absolute top-2 right-2 text-muted-foreground">
        <XIcon />
      </Button>
      <p className="pr-7 text-muted-foreground">{card.summary}</p>
      <p className="font-medium">{card.question}</p>
      <div className="mt-1 flex flex-wrap gap-2">
        {card.buttons.map((button, i) => (
          <Button
            key={button}
            variant="secondary"
            aria-keyshortcuts={i === 0 ? "Meta+Enter Control+Enter" : undefined}
            onClick={() => onAnswer(button)}
            className={cn("h-9 rounded-[11px] px-3.5", i === 0 && "bg-foreground text-background hover:bg-foreground/90")}
          >
            {button}
            {i === 0 && (
              // not on phones, which have no such keys
              <KbdGroup className="hidden pointer-fine:inline-flex">
                <Kbd className={KEY}>{/Mac|iPhone|iPad/.test(navigator.platform) ? <CommandIcon className="size-3.5" /> : "Ctrl"}</Kbd>
                <Kbd className={KEY}>
                  <CornerDownLeftIcon className="size-3.5" />
                </Kbd>
              </KbdGroup>
            )}
          </Button>
        ))}
      </div>
    </Card>
  );
}

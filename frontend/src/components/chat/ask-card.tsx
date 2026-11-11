"use client";

import type { AskCard as Card } from "@emplio/shared";
import { ArrowUpIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, PencilIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChatSendContext } from "@/components/chat/connect-card";
import { VoiceInput } from "@/components/chat/voice-input";

// What the person said right after this reply (their answer to a question in it), or undefined while unanswered.
export const ReplyContext = createContext<string | undefined>(undefined);

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Questions from the AI employee (emplio ask): tap an answer or write your own. One question sends on the tap.
// Several go one at a time (tapping an answer moves on, Back goes back), then a last look at all the answers
// and Send, one "question answer" line each. Either way it's the person's next message; after it the card
// shows what was answered and can't be answered again.
export function AskCard({ cards }: { cards: Card[] }) {
  const send = useContext(ChatSendContext);
  const reply = useContext(ReplyContext);
  const [sent, setSent] = useState<string>();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // which question is showing; cards.length is the last look before sending
  const [step, go] = useState(0);
  const [moved, setMoved] = useState(false);
  const setStep = (to: number | ((s: number) => number)) => {
    setMoved(true);
    go(to);
  };
  // a step the person moved to can be taller (the review, with Send at its foot): scroll just enough to show all of it
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (moved) box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [step, moved]);
  const text = (reply ?? sent)?.trim();
  const one = cards.length === 1;
  // once sent, each question's answer as the message has it
  const given = (c: Card) =>
    text === undefined
      ? answers[c.id]
      : one
        ? text
        : text.split("\n").find((l) => l.startsWith(c.question))?.slice(c.question.length).trim();
  const submit = (all: Record<string, string>) => {
    if (text !== undefined) return;
    const message = one ? all[cards[0]!.id]!.trim() : cards.map((c) => `${c.question} ${all[c.id]!.trim()}`).join("\n");
    setSent(message);
    send?.(message);
  };

  if (one) {
    const c = cards[0]!;
    return (
      <div className="flex w-full max-w-md flex-col gap-3 rounded-xl border bg-card p-3">
        <Question
          card={c}
          answer={given(c)}
          locked={text !== undefined}
          // one pick sends on the tap; several wait for Send
          onAnswer={(t) => (c.multi ? setAnswers({ [c.id]: t }) : t.trim() && submit({ [c.id]: t }))}
          onDone={() => c.multi && answers[c.id]?.trim() && submit(answers)}
          instant
        />
        {c.multi && text === undefined && (
          <Button size="sm" className="self-end" disabled={!answers[c.id]?.trim()} onClick={() => submit(answers)}>
            Send <ArrowUpIcon className="size-3.5" />
          </Button>
        )}
      </div>
    );
  }

  // answered: what was said to each, in one short list
  if (text !== undefined)
    return (
      <div className="flex w-full max-w-md flex-col gap-2.5 rounded-xl border bg-card p-3">
        {cards.map((c) => (
          <div key={c.id} className="flex flex-col gap-0.5 text-sm">
            <span className="text-muted-foreground">{c.question}</span>
            <span className="flex items-start gap-1.5 font-medium">
              <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
              {given(c) || "(answered in the message below)"}
            </span>
          </div>
        ))}
      </div>
    );

  const ready = cards.every((c) => answers[c.id]?.trim());
  const card = cards[step];
  // scroll-mb: clear of the message box that floats over the bottom of the chat
  return (
    <div ref={box} className="flex w-full max-w-md scroll-mb-40 flex-col gap-3 rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => setStep((s) => s - 1)}
          disabled={step === 0}
          aria-label="Previous question"
          className="-ml-1 flex size-6 items-center justify-center rounded-md hover:bg-accent hover:text-foreground disabled:invisible"
        >
          <ChevronLeftIcon className="size-4" />
        </button>
        <span className="tabular-nums">{card ? `Question ${step + 1} of ${cards.length}` : "Your answers"}</span>
        <div className="ml-auto flex gap-1" aria-hidden>
          {cards.map((c, i) => (
            <button
              key={c.id}
              type="button"
              tabIndex={-1}
              onClick={() => setStep(i)}
              className={`h-1.5 rounded-full transition-[width,background-color] ${i === step ? "w-4 bg-primary" : answers[c.id]?.trim() ? "w-1.5 bg-primary/50" : "w-1.5 bg-border"}`}
            />
          ))}
        </div>
      </div>
      {card ? (
        <>
          <Question
            key={card.id}
            card={card}
            answer={answers[card.id]}
            locked={false}
            onAnswer={(t) => setAnswers((a) => ({ ...a, [card.id]: t }))}
            onDone={() => setStep((s) => s + 1)}
            // the person moved here: ready to type; on a page load, don't take the cursor from the chat box
            focus={moved}
          />
          {/* a typed answer moves on with Next; a tapped one moves on by itself */}
          {!!answers[card.id]?.trim() && (
            <Button size="sm" variant="outline" className="self-end" onClick={() => setStep((s) => s + 1)}>
              {step === cards.length - 1 ? "Review" : "Next"} <ChevronRightIcon className="size-3.5" />
            </Button>
          )}
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            {cards.map((c, i) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setStep(i)}
                className="flex flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="text-muted-foreground">{c.question}</span>
                <span className={answers[c.id]?.trim() ? "font-medium" : "text-destructive"}>{answers[c.id]?.trim() || "Not answered yet"}</span>
              </button>
            ))}
          </div>
          <Button size="sm" className="self-end" disabled={!ready} onClick={() => submit(answers)}>
            Send answers <ArrowUpIcon className="size-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}

// One question. Pick one answer (a tap is the answer), or with card.multi any number, ticked on and off;
// a typed answer counts as one more. Several picks go as one line: "Gmail, Slack".
function Question({
  card,
  answer,
  locked,
  onAnswer,
  onDone,
  instant = false,
  focus = false,
}: {
  card: Card;
  answer?: string;
  locked: boolean;
  onAnswer: (text: string) => void;
  // tapped an answer (one-pick questions) or pressed Enter: send it, or show the next question
  onDone?: () => void;
  // one question on its own: a one-pick answer sends straight away
  instant?: boolean;
  focus?: boolean;
}) {
  const parts = answer === undefined ? [] : card.multi ? answer.split(", ") : [answer];
  const picks = card.options.filter((o) => parts.some((p) => same(p, o)));
  const ownAnswer = parts.filter((p) => p.trim() && !card.options.some((o) => same(p, o))).join(", ") || undefined;
  const [writing, setWriting] = useState(!card.options.length || !!ownAnswer);
  const [own, setOwn] = useState(ownAnswer ?? "");
  const answerWith = (chosen: string[], typed: string) =>
    card.multi ? [...chosen, typed.trim()].filter(Boolean).join(", ") : chosen[0] ?? typed;
  const tap = (o: string) => {
    if (card.multi) return onAnswer(answerWith(picks.includes(o) ? picks.filter((p) => p !== o) : [...card.options.filter((x) => x === o || picks.includes(x))], own));
    setWriting(false);
    setOwn("");
    onAnswer(o);
    onDone?.();
  };
  return (
    <div className="flex flex-col gap-2" role="group" aria-label={card.question}>
      {card.text && <p className="max-h-72 overflow-y-auto rounded-lg bg-muted/50 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap">{card.text}</p>}
      <p className="text-[0.9rem] leading-snug font-medium">{card.question}</p>
      {card.multi && !locked && <p className="-mt-1 text-xs text-muted-foreground">Pick all that apply</p>}
      {!!card.options.length && (
        <div className="flex flex-col gap-1.5">
          {card.options.map((o) => {
            const chosen = picks.includes(o);
            return (
              <button
                key={o}
                type="button"
                disabled={locked}
                onClick={() => tap(o)}
                aria-pressed={chosen}
                className={`flex min-h-10 items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  chosen
                    ? "border-primary bg-primary/10 font-medium text-foreground"
                    : locked
                      ? "text-muted-foreground opacity-60"
                      : "hover:border-primary/50 hover:bg-accent active:scale-[.99]"
                }`}
              >
                {card.multi && (
                  <span
                    className={`flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${chosen ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"}`}
                  >
                    {chosen && <CheckIcon className="size-3" strokeWidth={3} />}
                  </span>
                )}
                <span className="min-w-0 flex-1">{o}</span>
                {chosen && !card.multi && <CheckIcon className="size-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      )}
      {locked ? (
        ownAnswer && (
          <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <CheckIcon className="mt-px size-3.5 shrink-0 text-primary" />
            <span className="line-clamp-2">You answered: {ownAnswer}</span>
          </div>
        )
      ) : writing ? (
        <form
          className={`flex items-center gap-1.5 rounded-lg border bg-background pr-1 focus-within:border-primary/60 ${ownAnswer && !instant ? "border-primary" : ""}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (!answerWith(picks, own).trim()) return;
            onAnswer(answerWith(picks, own));
            onDone?.();
          }}
        >
          <input
            value={own}
            onChange={(e) => {
              setOwn(e.target.value);
              // typing is answering, except a lone one-pick question, which sends on Enter
              if (!instant || card.multi) onAnswer(answerWith(card.multi ? picks : [], e.target.value));
            }}
            autoFocus={!!card.options.length || focus}
            placeholder={card.multi ? "Add your own" : "Type your answer"}
            aria-label={`Your answer: ${card.question}`}
            className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
          />
          {/* speak the answer, as in the chat box: the words land in the field, to check before sending */}
          <VoiceInput
            onText={(t) => {
              const said = [own.trim(), t].filter(Boolean).join(" ");
              setOwn(said);
              if (!instant || card.multi) onAnswer(answerWith(card.multi ? picks : [], said));
            }}
          />
          {instant && !card.multi && (
            <button
              type="submit"
              disabled={!own.trim()}
              onMouseDown={(e) => e.preventDefault()} // keeps the focus: see the chat box's footer in chat-view.tsx
              aria-label="Send answer"
              className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
            >
              <ArrowUpIcon className="size-4" />
            </button>
          )}
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setWriting(true)}
          className="flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground"
        >
          <PencilIcon className="size-3" /> Something else
        </button>
      )}
    </div>
  );
}

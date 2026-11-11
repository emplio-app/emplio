"use client";

import type { PlanStep } from "@emplio/shared";
import { CheckIcon, ChevronRightIcon, CircleIcon, ListChecksIcon } from "lucide-react";
import { useState } from "react";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";

// The agent's checklist for a long job (emplio plan): one card per reply, always its latest state. Open while
// the job runs; once every step is done (or the reply has ended), it folds to one line that opens again.
export function PlanCard({ steps, live }: { steps: PlanStep[]; live: boolean }) {
  const done = steps.filter((s) => s.status === "done").length;
  const finished = done === steps.length;
  // null: follow the job (open while it runs); a click pins it open or shut
  const [pinned, setPinned] = useState<boolean | null>(null);
  const open = pinned ?? (live && !finished);
  if (!steps.length) return null;
  return (
    // mt-2: clear of the copy and edit buttons under their message
    <div className="mt-2 w-full overflow-hidden rounded-lg border bg-card text-sm">
      <button
        type="button"
        onClick={() => setPinned(!open)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:text-foreground"
      >
        <ListChecksIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium">{finished ? "All done" : live ? "Working on it" : "Checklist"}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          · {done} of {steps.length}
          {!open && !finished && steps.find((s) => s.status === "doing") ? ` · ${steps.find((s) => s.status === "doing")!.text}` : ""}
        </span>
        {/* folded: a short bar in the line; open: a full-width one under it */}
        {!open && <Progress value={(done / steps.length) * 100} aria-label={`${done} of ${steps.length} steps done`} className="h-1 w-16 shrink-0" />}
        <ChevronRightIcon className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <Progress value={(done / steps.length) * 100} aria-label={`${done} of ${steps.length} steps done`} className="h-0.5 rounded-none" />}
      {open && (
        <ol className="flex flex-col gap-1.5 px-3 py-2.5">
          {steps.map((s, i) => (
            <li key={i} className="flex min-w-0 items-start gap-2 text-[0.8rem] leading-snug">
              <span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
                {s.status === "done" ? (
                  <CheckIcon className="size-3.5 text-primary" />
                ) : s.status === "doing" && live ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <CircleIcon className={`size-3 ${s.status === "doing" ? "text-foreground" : "text-muted-foreground/50"}`} />
                )}
              </span>
              <span
                className={
                  s.status === "done" ? "text-muted-foreground line-through decoration-muted-foreground/40" : s.status === "doing" ? "font-medium" : "text-muted-foreground"
                }
              >
                {s.text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

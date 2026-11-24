"use client";

import { useMutation } from "@tanstack/react-query";
import { FlagIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { MessageAction } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";

const REASONS = ["Offensive or hateful", "Harmful or dangerous", "Sexual content", "Wrong or misleading", "Something else"];

// Under each of Emplio's replies: report it to the people who run Emplio (app stores require this for AI content).
export function ReportButton({ messageId }: { messageId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(REASONS[0]!);
  const [note, setNote] = useState("");
  const send = useMutation({
    mutationFn: () => api(`/messages/${messageId}/report`, { reason, note }),
    onSuccess: () => {
      setOpen(false);
      setNote("");
      toast.success("Thanks, we'll look into it.");
    },
  });
  return (
    <>
      <MessageAction tooltip="Report" onClick={() => setOpen(true)}>
        <FlagIcon />
      </MessageAction>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Report this reply</DialogTitle>
            <DialogDescription>It goes to the Emplio team, who review every report.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              send.mutate();
            }}
          >
            <RadioGroup value={reason} onValueChange={(v) => setReason(v as string)}>
              {REASONS.map((r) => (
                <Label key={r} className="font-normal">
                  <RadioGroupItem value={r} />
                  {r}
                </Label>
              ))}
            </RadioGroup>
            <Textarea placeholder="Anything to add (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
            {send.error && <p className="text-sm text-destructive">{send.error.message}</p>}
            <DialogFooter>
              <Button type="submit" disabled={send.isPending}>
                {send.isPending ? <Spinner /> : "Send report"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

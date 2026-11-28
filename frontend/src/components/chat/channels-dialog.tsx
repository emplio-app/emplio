"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, SendIcon, XIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/confirm";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";

export type Channels = {
  phone: string | null;
  telegram: { connected: boolean; url: string | null };
};
export const channelsQueryKey = ["channels"];

// Other ways to talk to the AI employee than this web app: Telegram now, WhatsApp and calls later.
// The person's mobile number is how those recognise them.
export function ChannelsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Channels</DialogTitle>
          <DialogDescription>
            Talk to Emplio from your phone too. It can also message you there on
            its own, like when a report is ready.
          </DialogDescription>
        </DialogHeader>
        {open && <ChannelsPanel />}
      </DialogContent>
    </Dialog>
  );
}

// the number and the Telegram link; also the welcome page's phone step
export function ChannelsPanel() {
  const queryClient = useQueryClient();
  const data = useQuery({
    queryKey: channelsQueryKey,
    queryFn: () => api<Channels>("/channels"),
    // linking happens in Telegram; show it here once it's done
    refetchInterval: 5_000,
  });
  const [phone, setPhone] = useState<string | null>(null);
  // Connect pressed on a computer: a code for the phone, or a link for here
  const [linking, setLinking] = useState(false);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: channelsQueryKey });
  const savePhone = useMutation({
    mutationFn: () =>
      api("/channels/phone", { phone: phone?.trim() || null }, "PUT"),
    onSuccess: () => {
      setPhone(null);
      void refresh();
    },
  });
  // people type the number and move on without pressing Save: it saves as they leave the box
  const dirty = phone !== null && phone.trim() !== (data.data?.phone ?? "");
  const saveIfChanged = () => {
    if (dirty && !savePhone.isPending) savePhone.mutate();
  };
  const disconnect = useMutation({
    mutationFn: () => api("/channels/telegram", undefined, "DELETE"),
    onSettled: refresh,
  });
  const [confirmDialog, confirm] = useConfirm();
  const d = data.data;
  const shown = phone ?? d?.phone ?? "";

  return (
    <>
      {!d ? (
        <div className="grid gap-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : (
        <div className="grid gap-5">
          <form
            className="grid gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              savePhone.mutate();
            }}
          >
            <label htmlFor="phone" className="text-sm font-medium">
              Your mobile number
            </label>
            <div className="flex gap-2">
              <Input
                id="phone"
                type="tel"
                autoComplete="tel"
                placeholder="+91 98765 43210"
                value={shown}
                onChange={(e) => setPhone(e.target.value)}
                onBlur={saveIfChanged}
              />
              {dirty || savePhone.isPending ? (
                <Button type="submit" disabled={savePhone.isPending}>
                  {savePhone.isPending ? "Saving…" : "Save"}
                </Button>
              ) : (
                d.phone && (
                  <span className="inline-flex shrink-0 items-center gap-1 px-2 text-xs font-medium text-primary">
                    <CheckIcon className="size-3.5" /> Saved
                  </span>
                )
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              With the country code. Telegram and, later, WhatsApp and calls
              know it&apos;s you by this number.
            </p>
            {savePhone.error && (
              <p className="text-sm text-destructive">
                {savePhone.error.message}
              </p>
            )}
          </form>

          <div className="flex items-center gap-3 rounded-xl border p-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#229ED9] text-white">
              <SendIcon className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Telegram</div>
              <div className="text-xs text-muted-foreground">
                {d.telegram.connected
                  ? "Connected. Send /new there to start a fresh chat."
                  : d.telegram.url
                    ? "Open the bot and press Start, or share your number with it."
                    : "Not set up on this server yet."}
              </div>
            </div>
            {d.telegram.connected ? (
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                  <CheckIcon className="size-3.5" /> Connected
                </span>
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto p-0 text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    confirm({
                      title: "Disconnect Telegram?",
                      description:
                        "You won't be able to message Emplio there, and it won't reach you there.",
                      action: "Disconnect",
                      onConfirm: () => disconnect.mutate(),
                    })
                  }
                >
                  Disconnect
                </Button>
              </div>
            ) : (
              d.telegram.url && (
                <Button
                  size="sm"
                  variant={linking ? "outline" : "default"}
                  onClick={() => {
                    saveIfChanged();
                    // a phone opens Telegram right here; a computer gets the choice below
                    if (matchMedia("(pointer: coarse)").matches) window.open(d.telegram.url!, "_blank", "noreferrer");
                    else setLinking(!linking);
                  }}
                >
                  {linking ? "Close" : "Connect"}
                </Button>
              )
            )}
          </div>
          {linking && !d.telegram.connected && d.telegram.url && (
            <div className="grid gap-4 rounded-xl border p-4 animate-in fade-in slide-in-from-top-1 duration-200 sm:grid-cols-2">
              <div className="flex flex-col items-center gap-2 text-center">
                <QRCodeSVG value={d.telegram.url} size={132} marginSize={2} className="rounded-lg bg-white" />
                <div className="text-sm font-medium">On your phone</div>
                <p className="text-xs text-muted-foreground">
                  Point the camera at this, open the link, and press Start.
                </p>
              </div>
              <div className="flex flex-col items-center justify-center gap-2 border-t pt-4 text-center sm:border-t-0 sm:border-l sm:pt-0 sm:pl-4">
                <div className="text-sm font-medium">On this computer</div>
                <p className="text-xs text-muted-foreground">
                  If Telegram is on this computer, or open it in the browser.
                </p>
                <Button size="sm" nativeButton={false} render={<a href={d.telegram.url} target="_blank" rel="noreferrer" />}>
                  Open Telegram
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {confirmDialog}
    </>
  );
}

// In the sidebar until Telegram is connected: Emplio can only reach them in the web app without it.
// Closing it hides it for a week on this device.
const NUDGE_KEY = "telegram-nudge-hidden-until";
export function ChannelNudge() {
  const { data } = useQuery({ queryKey: channelsQueryKey, queryFn: () => api<Channels>("/channels") });
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(() => {
    try {
      return Number(localStorage.getItem(NUDGE_KEY)) > Date.now();
    } catch {
      return false;
    }
  });
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(NUDGE_KEY, String(Date.now() + 7 * 24 * 3600_000));
    } catch {}
  };
  // on a laptop there's no bot (the live server has it), but the card still shows, to see how it looks
  const bot = !!data?.telegram.url || process.env.NODE_ENV === "development";
  if (!data || !bot || data.telegram.connected || (hidden && !open)) return <ChannelsDialog open={open} onOpenChange={setOpen} />;
  return (
    <>
      <div className="relative mb-2 rounded-xl border border-warning/30 bg-warning/10 p-3 group-data-[collapsible=icon]:hidden">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={hide}
          aria-label="Hide for a week"
          className="absolute top-1.5 right-1.5 text-muted-foreground"
        >
          <XIcon className="size-3.5" />
        </Button>
        <div className="flex items-center gap-2 pr-5">
          <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-[#229ED9] text-white">
            <SendIcon className="size-3.5" />
          </div>
          <div className="text-sm font-medium">Emplio on your phone</div>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Connect Telegram to chat on the go and get reports and reminders there.
        </p>
        <Button size="sm" className="mt-2.5 w-full" onClick={() => setOpen(true)}>
          Connect Telegram
        </Button>
      </div>
      <ChannelsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

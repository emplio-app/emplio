"use client";

// A new person's first minutes: what Emplio can do (the welcome dialog, once, right after signing up), jobs to start
// with (the empty chat's cards), and Telegram offered once they've sent a couple of messages.
import { SeePlans, track, useCreditStatus } from "@cloud/client";
import type { UIMessage } from "ai";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarClockIcon,
  FileTextIcon,
  GlobeIcon,
  MailIcon,
  MegaphoneIcon,
  SearchIcon,
  SendIcon,
  TableIcon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChannelsDialog, type Channels, channelsQueryKey } from "@/components/chat/channels-dialog";
import { api, useMe } from "@/lib/api";

type Capability = { icon: LucideIcon; title: string; what: string; job: string };
// jobs a chat app can't do (its own browser, your apps, on a schedule, the whole team); the same for every business
export const CAPABILITIES: Capability[] = [
  { icon: FileTextIcon, title: "Documents and files", what: "Quotes, price lists, letters and reports, as PDF or Word.", job: "Read my website and turn what we sell into a one-page price list PDF" },
  { icon: SearchIcon, title: "Research", what: "Looks things up and compares them for you.", job: "Visit the websites of 10 businesses like mine nearby and put their prices in a spreadsheet" },
  { icon: MegaphoneIcon, title: "Marketing", what: "Posts, ads and offers in your voice.", job: "Read my website, then write a week of Instagram posts that sound like us" },
  { icon: TableIcon, title: "Spreadsheets", what: "Trackers and sheets, filled in and kept tidy.", job: "Make an order tracker spreadsheet, and every evening tell me which orders are still pending" },
  { icon: MailIcon, title: "Email and your apps", what: "Reads and drafts email, works in Gmail, Sheets, Slack and more.", job: "Connect my Gmail, read today's enquiries and draft replies for me to approve" },
  { icon: CalendarClockIcon, title: "Repeating work", what: "Does a job every day or week without being asked.", job: "Every Monday at 9am, check my competitors' websites and tell me what changed" },
  { icon: GlobeIcon, title: "Its own browser", what: "Opens websites, fills forms and checks pages.", job: "Open my website like a customer would, try every page and form, and list what's broken" },
  { icon: UsersIcon, title: "Your whole team", what: "Everyone in the business can give it work.", job: "Help me add my team, then send each of them a to-do list every morning" },
];
// the empty chat's cards
const CARDS = CAPABILITIES.slice(0, 6);

export function JobCards({ onPick }: { onPick: (job: string) => void }) {
  return (
    <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {CARDS.map((c) => (
        <button
          key={c.title}
          type="button"
          onClick={() => (track("job_card_clicked", { card: c.title }), onPick(c.job))}
          className="flex items-start gap-3 rounded-xl border bg-card p-3 text-left text-sm transition-colors hover:bg-muted"
        >
          <c.icon className="mt-0.5 size-4 shrink-0 text-primary" />
          <span className="min-w-0">
            <span className="block font-medium">{c.title}</span>
            <span className="block text-muted-foreground">{c.job}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

// The login page sets this when someone has just signed up (or joined a team), for the chat they land on.
export const JUST_JOINED = "emplio-just-joined";

export function WelcomeDialog({ onTry, busy }: { onTry: (job: string) => void; busy: boolean }) {
  const { data: me } = useMe();
  const credit = useCreditStatus().data;
  const [open, setOpen] = useState(() => {
    try {
      if (!sessionStorage.getItem(JUST_JOINED)) return false;
      sessionStorage.removeItem(JUST_JOINED);
      track("welcome_seen");
      return true;
    } catch {
      return false;
    }
  });
  const business = me?.workspaces[0];
  if (!business) return null;
  const owner = business.role === "owner";
  // no free trial (switched off, or the day's are gone): nothing runs until a plan is picked
  const paused = !!credit?.paused;
  const tryIt = (c: Capability) => {
    track("welcome_try_clicked", { card: c.title });
    setOpen(false);
    onTry(c.job);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-heading text-2xl">{owner ? "Meet Emplio, your new employee" : `Welcome to ${business.name}`}</DialogTitle>
          <DialogDescription>
            {busy
              ? "It's already working on your first job. Here's what else you can hand it."
              : owner
                ? "Give it work the way you would a person. Here's what it can do."
                : `Emplio works for the whole team at ${business.name}. Here's what you can hand it.`}
          </DialogDescription>
        </DialogHeader>
        {paused && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            {owner ? "Free trials are paused right now. Pick a plan and Emplio starts work straight away." : "Emplio is paused until the owner picks a plan."}
          </div>
        )}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {CAPABILITIES.map((c) => (
            <div key={c.title} className="flex items-start gap-3 rounded-xl border p-3">
              <c.icon className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{c.title}</div>
                <p className="text-sm text-muted-foreground">{c.what}</p>
              </div>
              {!paused && (
                <Button size="sm" variant="outline" className="shrink-0" onClick={() => tryIt(c)}>
                  Try
                </Button>
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          {paused && owner ? (
            <SeePlans />
          ) : (
            <Button onClick={() => setOpen(false)}>{busy ? "Back to my job" : "I'll type my own"}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// After their second message, once: Emplio on their phone. Closing it is for good on this device.
const OFFERED = "emplio-telegram-offered";
export function TelegramOffer({ messages }: { messages: UIMessage[] }) {
  const [gone, setGone] = useState(() => {
    try {
      return !!localStorage.getItem(OFFERED);
    } catch {
      return false;
    }
  });
  const [open, setOpen] = useState(false);
  const sent = messages.filter((m) => m.role === "user").length;
  const { data } = useQuery({ queryKey: channelsQueryKey, queryFn: () => api<Channels>("/channels"), enabled: !gone && sent >= 2 });
  const close = () => {
    setGone(true);
    try {
      localStorage.setItem(OFFERED, "1");
    } catch {}
  };
  // on a laptop there's no bot (the live server has it), but the card still shows, to see how it looks
  const bot = !!data?.telegram.url || process.env.NODE_ENV === "development";
  if (gone || sent < 2 || !data || data.telegram.connected || !bot) return <ChannelsDialog open={open} onOpenChange={setOpen} />;
  return (
    <>
      <div className="mb-2 flex items-center gap-3 rounded-2xl border bg-card px-4 py-2.5 text-sm shadow-sm">
        <SendIcon className="size-4 shrink-0 text-[#229ED9]" />
        <span className="min-w-0 flex-1 text-muted-foreground">Get Emplio on your phone: chat in Telegram and get its reports there.</span>
        <Button size="sm" className="shrink-0 rounded-full" onClick={() => (track("telegram_offer_clicked"), close(), setOpen(true))}>
          Connect
        </Button>
        <button type="button" onClick={close} aria-label="Not now" className="rounded p-0.5 text-muted-foreground hover:text-foreground">
          <XIcon className="size-3.5" />
        </button>
      </div>
      <ChannelsDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

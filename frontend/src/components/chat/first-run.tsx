"use client";

// A new person's first minutes: what Emplio can do (the welcome dialog, once, right after signing up), jobs to start
// with (the empty chat's cards), and Telegram offered once they've sent a couple of messages.
import { SeePlans, track, useCreditStatus } from "@cloud/client";
import { inApp } from "@/lib/save-file";
import type { UIMessage } from "ai";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRightIcon,
  BellIcon,
  CalendarClockIcon,
  FileTextIcon,
  GlobeIcon,
  MailIcon,
  MegaphoneIcon,
  SearchIcon,
  SendIcon,
  ShuffleIcon,
  TableIcon,
  UsersIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChannelsDialog, type Channels, channelsQueryKey } from "@/components/chat/channels-dialog";
import { api, useMe } from "@/lib/api";
import { skipTour, startTour } from "@/components/tour";

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
// the empty chat's categories, each with a few starting jobs (the first is the card's own job)
const CARDS = CAPABILITIES.slice(0, 6);
const MORE: Record<string, string[]> = {
  "Documents and files": [
    "Write a friendly quote template I can send to customers, as a Word file",
    "Turn my last week of emails into a short report as a PDF",
    "Make a one-page flyer for my best-selling product",
  ],
  Research: [
    "Find 5 customers who might need what I sell and tell me how to reach them",
    "Check what my competitors charge and tell me if I'm too cheap or too dear",
    "Read the news about my industry this week and give me the 5 things that matter",
  ],
  Marketing: [
    "Write 3 offers I could run this month and the message for each",
    "Read my Google reviews and write a thank-you reply to each one",
    "Write a WhatsApp message to bring back customers who haven't ordered in a while",
  ],
  Spreadsheets: [
    "Make a simple expenses sheet and ask me each Friday to fill in the week",
    "Turn my customer list into a tidy sheet, with duplicates removed",
    "Build a sheet to track my stock and warn me when something runs low",
  ],
  "Email and your apps": [
    "Connect my Gmail and tell me which emails need a reply today",
    "Read my unread email and give me a 5-line summary every morning",
    "Connect Slack and post a daily summary of the day's orders",
  ],
  "Repeating work": [
    "Every evening at 6pm, send me a summary of what happened today",
    "Every Friday, remind my team to update the tracker",
    "Every morning at 8am, tell me what's on for the day",
  ],
};
// what's most useful at this hour comes first
const BY_HOUR = [
  ["Email and your apps", "Repeating work", "Spreadsheets"], // before noon: start the day
  ["Marketing", "Documents and files", "Research"], // afternoon: get things made
  ["Repeating work", "Spreadsheets", "Research"], // evening: set up tomorrow
];

const dayOfYear = () => Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 864e5);

// ponytail: no per-business learning yet; hour of day, day of year and the shuffle button vary it
// each category shows this long before the next; a CSS animation (paused by hover, reduced motion: none) times it
const ROTATE_MS = 8000;

export function JobCards({ onPick, paused }: { onPick: (job: string) => void; paused?: boolean }) {
  const [shuffle, setShuffle] = useState(0);
  const [hover, setHover] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const cards = useMemo(() => {
    const hour = new Date().getHours();
    const first = BY_HOUR[hour < 12 ? 0 : hour < 18 ? 1 : 2]!;
    const rank = (t: string) => (first.includes(t) ? first.indexOf(t) : first.length);
    return [...CARDS].sort((a, b) => rank(a.title) - rank(b.title));
  }, []);
  const card = cards.find((c) => c.title === picked) ?? cards[0]!;
  const jobs = useMemo(() => {
    const all = [card.job, ...(MORE[card.title] ?? [])];
    const start = (dayOfYear() + shuffle) % all.length;
    return [0, 1, 2].map((i) => all[(start + i) % all.length]!);
  }, [card, shuffle]);

  const next = () => (setPicked(cards[(cards.indexOf(card) + 1) % cards.length]!.title), setShuffle(0));

  return (
    <div className="mt-5" onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)} onPointerLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}>
      <div className="-mx-4 flex snap-x scroll-px-4 gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
        {cards.map((c) => {
          const on = c === card;
          return (
            <button
              key={c.title}
              type="button"
              aria-pressed={on}
              onClick={() => (setPicked(c.title), setShuffle(0))}
              className={`relative flex shrink-0 snap-start items-center gap-2 overflow-hidden rounded-full border px-3.5 py-2 text-sm transition-colors active:scale-[0.97] ${on ? "border-primary/50 bg-card text-foreground" : "bg-card text-muted-foreground hover:bg-muted"}`}
            >
              {on && (
                <span
                  aria-hidden
                  // keyed so a new category (or a shuffle) starts it again; scaleX, not width, so nothing re-lays out
                  key={`${c.title}${shuffle}`}
                  onAnimationEnd={next}
                  className="absolute inset-0 origin-left bg-primary/10 motion-safe:animate-[chip-fill_linear_forwards]"
                  style={{ animationDuration: `${ROTATE_MS}ms`, animationPlayState: hover || paused ? "paused" : "running" }}
                />
              )}
              <c.icon className="relative size-4 text-primary" />
              <span className="relative">{c.title}</span>
            </button>
          );
        })}
      </div>
      <div key={`${card.title}${shuffle}`} className="mt-3 animate-[fade-in_250ms_ease-out] overflow-hidden rounded-2xl border bg-card motion-reduce:animate-none">
        {jobs.map((job) => (
          <button
            key={job}
            type="button"
            onClick={() => (track("job_card_clicked", { card: card.title }), onPick(job))}
            className="flex w-full items-start gap-3 border-b px-4 py-3.5 text-left text-sm transition-colors last:border-b-0 hover:bg-muted active:bg-muted"
          >
            <span className="min-w-0 flex-1">{job}</span>
            <ArrowUpRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setShuffle((n) => n + 1)}
        className="mx-auto mt-3 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ShuffleIcon className="size-3.5" />
        Show other ideas
      </button>
    </div>
  );
}

// The login page sets this when someone has just signed up (or joined a team), for the chat they land on.
export const JUST_JOINED = "emplio-just-joined";
const TOUR = "emplio-tour";

// The product tour again (account menu): the welcome dialog in the main chat, then the guided tour (tour.tsx).
// Already in the main chat, it opens there; anywhere else, the main chat opens it when it loads.
export function takeTour(mainChat: string, pathname: string, go: (path: string) => void) {
  track("tour_replayed");
  skipTour();
  if (pathname === mainChat) return void dispatchEvent(new Event(TOUR));
  try {
    sessionStorage.setItem(JUST_JOINED, "1");
  } catch {}
  go(mainChat);
}

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
  useEffect(() => {
    const again = () => setOpen(true);
    addEventListener(TOUR, again);
    return () => removeEventListener(TOUR, again);
  }, []);
  const business = me?.workspaces[0];
  if (!business) return null;
  const owner = business.role === "owner";
  // no free trial (switched off, or the day's are gone): nothing runs until a plan is picked
  const paused = !!credit?.paused;
  // closing it in any way but Skip starts the guided tour, before they really start
  const close = (tour: boolean) => {
    setOpen(false);
    if (tour) startTour();
    else track("tour_skipped", { step: -1 });
  };
  const tryIt = (c: Capability) => {
    track("welcome_try_clicked", { card: c.title });
    close(true);
    onTry(c.job);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close(true))}>
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
            {inApp() ? "Emplio is paused for this business right now." : owner ? "Free trials are paused right now. Pick a plan and Emplio starts work straight away." : "Emplio is paused until the owner picks a plan."}
          </div>
        )}
        {/* on a phone the first four, so the sheet fits the screen without scrolling */}
        <div className="grid grid-cols-1 gap-2 max-sm:[&>:nth-child(n+5)]:hidden sm:grid-cols-2">
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
            <>
              <Button variant="ghost" className="text-muted-foreground" onClick={() => close(false)}>
                Skip tour
              </Button>
              <Button onClick={() => close(true)}>Show me around</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// In the iPhone app. Notifications are asked for once they've given Emplio a job, the moment a ping is worth having:
// iOS asks only once, so asking at sign-in, on top of the welcome dialog, mostly got a reflex "Don't Allow".
type PhonePush = {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
};
// iPhone only: the Android app has no Firebase set up, and registering there crashed it right after sign-in
export const phonePush = () => {
  const cap = (window as { Capacitor?: { getPlatform?(): string; Plugins?: { PushNotifications?: PhonePush } } }).Capacitor;
  return cap?.getPlatform?.() === "ios" ? cap.Plugins?.PushNotifications : undefined;
};

const NOTIFY_ASKED = "emplio-notify-asked";
function useNotifyOffer(sent: number) {
  const [ask, setAsk] = useState(false);
  useEffect(() => {
    const push = phonePush();
    try {
      if (!push || sent < 1 || localStorage.getItem(NOTIFY_ASKED)) return;
    } catch {
      return;
    }
    // not decided yet: iOS hasn't asked
    void push.checkPermissions().then((p) => setAsk(p.receive.startsWith("prompt")), () => {});
  }, [sent]);
  const answer = (yes: boolean) => {
    setAsk(false);
    try {
      localStorage.setItem(NOTIFY_ASKED, "1");
    } catch {}
    track("notify_offer_answered", { yes });
    // granted: the app layout's listener sends the server this phone's address
    if (yes) void phonePush()?.requestPermissions().then((p) => (p.receive === "granted" ? phonePush()?.register() : undefined));
  };
  return { ask, answer };
}

// Under the empty composer, one at a time: notifications in the iPhone app first, then Telegram.
export function Offers({ messages }: { messages: UIMessage[] }) {
  const notify = useNotifyOffer(messages.filter((m) => m.role === "user").length);
  if (!notify.ask) return <TelegramOffer messages={messages} />;
  return (
    <div className="mb-2 flex items-center gap-3 rounded-2xl border bg-card px-4 py-2.5 text-sm shadow-sm">
      <BellIcon className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 text-muted-foreground">Get a ping when Emplio finishes a job or needs your OK.</span>
      <Button size="sm" className="shrink-0 rounded-full" onClick={() => notify.answer(true)}>
        Turn on
      </Button>
      <button type="button" onClick={() => notify.answer(false)} aria-label="Not now" className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground">
        <XIcon className="size-3.5" />
      </button>
    </div>
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

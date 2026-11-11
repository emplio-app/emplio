"use client";

import type { UIMessage } from "ai";
import { ChevronLeftIcon, CircleDotIcon, EyeIcon, GlobeIcon, MicIcon, MicOffIcon, MousePointerClickIcon, XIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { startVoice } from "./show-voice";
import { transcribe } from "./voice-input";

// The chat's browser, watched live beside the chat. The agent drives it with `emplio browser`;
// the server stops it after 10 minutes unused, so the link is checked while it's showing. For 24 hours after that
// the Live browser button starts it again.
// A command that used it carries only the browser's id (the agent never sees the live link); the link
// itself comes from the server. (Older chats carry the link.)

const browsersOf = (messages: UIMessage[]) =>
  messages.flatMap((m) =>
    m.parts.flatMap((p) => {
      const b = p.type === "tool-bash" && "output" in p ? (p.output as { browser?: { id?: string; liveUrl?: string } })?.browser : undefined;
      const mark = b?.id ?? b?.liveUrl;
      return mark ? [mark] : [];
    }),
  );

// Whether the panel was showing when they left this chat, per device.
const panelKey = (id: string) => `browser-open:${id}`;
const panelWasOpen = (id: string) => {
  try {
    return localStorage.getItem(panelKey(id)) === "1";
  } catch {
    return false;
  }
};
const keepPanel = (id: string, on: boolean) => {
  try {
    if (on) localStorage.setItem(panelKey(id), "1");
    else localStorage.removeItem(panelKey(id));
  } catch {}
};

export function useLiveBrowser(id: string, messages: UIMessage[]) {
  const [url, setUrl] = useState<string | null>(null);
  const [open, setShown] = useState(false);
  const setOpen = useCallback(
    (on: boolean) => {
      setShown(on);
      keepPanel(id, on);
    },
    [id],
  );
  // stopped, but its button can still start it again
  const [canReopen, setCanReopen] = useState(false);
  const [reopening, setReopening] = useState(false);
  // "Show Emplio how" is recording (the server's word: it can end there too)
  const [showing, setShowing] = useState(false);
  // when it began on this device's clock: their voice and the timer count from it
  const [began, setBegan] = useState<number | null>(null);
  // their voice with it. off: they said no. blocked: the mic wouldn't open, and the recording carries on without
  const voice = useRef<Awaited<ReturnType<typeof startVoice>> | null>(null);
  const voiceTry = useRef(0);
  const [mic, setMic] = useState<"on" | "muted" | "off" | "blocked">("off");
  const hidePointer = useCallback(
    (hidden: boolean) => void api(`/conversations/${id}/browser/pointer`, { hidden }).catch(() => {}),
    [id],
  );
  const marks = browsersOf(messages);
  const latest = marks.at(-1) ?? null;
  const seen = useRef<string | null>(latest);

  // a browser started in this reply: show it as soon as the agent touches it
  useEffect(() => {
    if (!latest || latest === seen.current) return;
    seen.current = latest;
    api<{ liveUrl: string | null; canReopen?: boolean }>(`/conversations/${id}/browser`)
      .then((r) => {
        setUrl(r.liveUrl);
        setCanReopen(!!r.canReopen);
        setOpen(!!r.liveUrl);
      })
      .catch(() => {});
  }, [id, latest, setOpen]);

  // coming back to a chat: is its browser still running, and was the panel showing when they left?
  const started = messages.length > 0;
  useEffect(() => {
    if (!started) return;
    api<{ liveUrl: string | null; canReopen?: boolean; showing?: boolean; showingFor?: number | null }>(`/conversations/${id}/browser`)
      .then((r) => {
        setUrl(r.liveUrl);
        setCanReopen(!!r.canReopen);
        // it stopped while they were away: the button brings it back, it doesn't start by itself
        setOpen(!!r.liveUrl && panelWasOpen(id));
        setShowing(!!r.showing);
        setBegan(r.showing ? Date.now() - (r.showingFor ?? 0) : null);
      })
      .catch(() => {});
  }, [id, started, setOpen]);

  // notice when it stops (idle, or closed elsewhere)
  useEffect(() => {
    if (!url) return;
    const timer = setInterval(() => {
      api<{ liveUrl: string | null; canReopen?: boolean; showing?: boolean }>(`/conversations/${id}/browser`)
        .then((r) => {
          setShowing(!!r.showing);
          setCanReopen(!!r.canReopen);
          if (r.liveUrl) return;
          setUrl(null);
          setOpen(false);
        })
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, [id, url, setOpen]);

  // the recording ended without Done here (too long, the server restarted): let go of the mic
  useEffect(() => {
    if (showing) return;
    void voice.current?.stop();
    voice.current = null;
  }, [showing]);

  // the same object until something changes, so what shows it isn't drawn again on every key
  return useMemo(() => {
    const openVoice = (from: number) => {
      const attempt = ++voiceTry.current;
      const said = (at: number, text: string | null) => api(`/conversations/${id}/browser/show/say`, { at, text });
      // no mic on a page without https, or they turned it down
      if (!navigator.mediaDevices) return setMic("blocked");
      startVoice(from, transcribe, said)
        .then((v) => {
          // they finished while the browser was still asking for the mic
          if (attempt !== voiceTry.current) return void v.stop();
          voice.current = v;
          setMic("on");
        })
        .catch(() => setMic("blocked"));
    };
    return {
      url,
      canReopen,
      reopening,
      open: open && !!url,
      showing,
      began,
      mic: showing ? mic : ("off" as const),
      hidePointer,
      level: () => voice.current?.level() ?? 0,
      startShowing: async (withVoice: boolean) => {
        try {
          await api(`/conversations/${id}/browser/show`, {});
        } catch {
          return;
        }
        const now = Date.now();
        setShowing(true);
        setBegan(now);
        setMic("off");
        if (withVoice) openVoice(now);
      },
      // the mic button: mute and back, or turn their voice on after all
      toggleMic: () => {
        if (mic === "on" || mic === "muted") {
          voice.current?.mute(mic === "on");
          setMic(mic === "on" ? "muted" : "on");
        } else if (began) openVoice(began);
      },
      endShowing: async (keep: boolean) => {
        const v = voice.current;
        voice.current = null;
        voiceTry.current++;
        setMic("off");
        setShowing(false);
        setBegan(null);
        // what they were still saying is on its way first, so it's in the file
        await v?.stop().catch(() => {});
        await api(`/conversations/${id}/browser/show/end`, { keep }).catch(() => {});
      },
      show: () => setOpen(true),
      hide: () => setOpen(false),
      reopen: async () => {
        setReopening(true);
        try {
          const r = await api<{ liveUrl: string }>(`/conversations/${id}/browser/open`, {});
          setUrl(r.liveUrl);
          setOpen(true);
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Couldn't open the browser. Try again.");
        } finally {
          setReopening(false);
        }
      },
      close: () => {
        setUrl(null);
        setOpen(false);
        setCanReopen(true);
        void api(`/conversations/${id}/browser`, undefined, "DELETE").catch(() => {});
      },
    };
  }, [id, url, canReopen, reopening, open, setOpen, showing, began, mic, hidePointer]);
}

type LiveBrowser = ReturnType<typeof useLiveBrowser>;
const BrowserContext = createContext<LiveBrowser | null>(null);
export const BrowserProvider = BrowserContext.Provider;
export const useBrowser = () => useContext(BrowserContext);

// "Live browser" button: in the header and under a run of commands, whenever the panel is hidden. Once the browser
// has stopped, it starts it again.
export function BrowserChip({ className = "" }: { className?: string }) {
  const browser = useBrowser();
  if (!browser || browser.open || (!browser.url && !browser.canReopen)) return null;
  return (
    <button
      type="button"
      disabled={browser.reopening}
      onClick={browser.url ? browser.show : browser.reopen}
      className={`inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-60 ${className}`}
    >
      {browser.url ? <LiveDot /> : <GlobeIcon className="size-3.5 text-muted-foreground" />}
      {browser.reopening ? "Opening…" : "Live browser"}
    </button>
  );
}

const LiveDot = () => (
  <span className="relative flex size-2">
    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />
    <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
  </span>
);

// Beside the chat on wide screens, full screen on phones. Watching by default, so a stray click
// doesn't fight the agent; "Take control" hands the mouse and keyboard to the person.
// panel width in px on wide screens, remembered per device and per panel; null = half the screen
const MIN_PANEL = 360;
const MIN_CHAT = 420;

// also the file panel's (files/file-viewer.tsx)
export function usePanelWidth(key = "browser-panel-width") {
  const WIDTH_KEY = key;
  const [width, setWidth] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem(WIDTH_KEY)) || null;
    } catch {
      return null;
    }
  });
  const [dragging, setDragging] = useState(false);
  const save = (w: number | null) => {
    setWidth(w);
    try {
      if (w) localStorage.setItem(WIDTH_KEY, String(w));
      else localStorage.removeItem(WIDTH_KEY);
    } catch {}
  };
  // drag the panel's left edge; the page, not the iframe, has to get the pointer while dragging
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: PointerEvent) =>
      save(Math.round(Math.min(Math.max(window.innerWidth - ev.clientX, MIN_PANEL), window.innerWidth - MIN_CHAT)));
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return { width, dragging, onPointerDown, reset: () => save(null) };
}

// the side panel's shell, shared with the file panel: beside the chat on wide screens, full screen on phones and
// tablets (clear of the status bar and home bar there), its left edge dragged to resize
export function SidePanel({ label, widthKey, children }: { label: string; widthKey?: string; children: (dragging: boolean) => React.ReactNode }) {
  const panel = usePanelWidth(widthKey);
  return (
    <aside
      aria-label={label}
      style={{ "--panel-w": panel.width ? `${panel.width}px` : "min(50%, 960px)" } as React.CSSProperties}
      className="fixed inset-0 z-40 flex flex-col bg-background pt-(--safe-top) pb-(--safe-bottom) animate-in fade-in slide-in-from-right-4 duration-200 lg:relative lg:pt-0 lg:pb-0 lg:z-auto lg:w-(--panel-w) lg:max-w-[calc(100%-420px)] lg:shrink-0 lg:border-l"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label.toLowerCase()} panel`}
        title="Drag to resize · double-click to reset"
        onPointerDown={panel.onPointerDown}
        onDoubleClick={panel.reset}
        className={`absolute inset-y-0 -left-1.5 z-10 hidden w-3 cursor-col-resize lg:block after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:transition-colors hover:after:bg-primary/40 ${panel.dragging ? "after:bg-primary/60" : ""}`}
      />
      {children(panel.dragging)}
    </aside>
  );
}

// The time on the recording.
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <span className="text-xs tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </span>
  );
}

// Their voice as it goes, so it's plain the mic is hearing them; flat when muted. Drawn straight to the bars, not through
// React, as it changes many times a second.
const WAVE_BARS = 18;
function VoiceWave({ level }: { level: () => number }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    const heard: number[] = Array(WAVE_BARS).fill(0);
    const timer = setInterval(() => {
      heard.shift();
      heard.push(level());
      heard.forEach((h, i) => {
        const bar = bars.current[i];
        if (bar) bar.style.height = `${Math.max(12, h * 100)}%`;
      });
    }, 70);
    return () => clearInterval(timer);
  }, [level]);
  return (
    <span aria-hidden className="flex h-5 items-center gap-0.5">
      {Array.from({ length: WAVE_BARS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="h-[12%] w-0.5 rounded-full bg-destructive transition-[height] duration-75"
        />
      ))}
    </span>
  );
}

export function BrowserPanel() {
  const browser = useBrowser();
  const [control, setControl] = useState(false);
  const [closing, setClosing] = useState(false);
  // "Show Emplio how" clicked: with their voice, or not?
  const [asking, setAsking] = useState(false);
  // recording hands them the browser too
  const inControl = control || !!browser?.showing;
  const hidePointer = browser?.hidePointer;
  const live = !!browser?.url;
  useEffect(() => {
    if (!live || !hidePointer) return;
    hidePointer(inControl);
    return () => {
      if (inControl) hidePointer(false);
    };
  }, [live, hidePointer, inControl]);
  // a click on the page while only watching: say how to use it, for a few seconds
  const [nudged, setNudged] = useState(false);
  const nudgeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const nudge = () => {
    setNudged(true);
    clearTimeout(nudgeTimer.current);
    nudgeTimer.current = setTimeout(() => setNudged(false), 3500);
  };
  const takeControl = (on: boolean) => {
    setControl(on);
    setNudged(false);
  };
  if (!browser?.open || !browser.url) return null;
  const url = browser.url;
  const micLabel = browser.mic === "on" ? "Mute your voice" : browser.mic === "muted" ? "Unmute your voice" : "Record your voice too";
  return (
    <SidePanel label="Live browser">
      {(dragging) => (
      <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 max-sm:gap-1 max-sm:pr-2 max-sm:pl-1.5">
        {/* on a phone the panel covers the chat: back to it first, the browser keeps going (the chip brings it back) */}
        {!browser.showing && (
          <Button size="icon" variant="ghost" onClick={browser.hide} className="size-10 lg:hidden" aria-label="Back to chat" title="Back to chat">
            <ChevronLeftIcon className="size-5" />
          </Button>
        )}
        {browser.showing ? (
          <span role="status" className="flex min-w-0 items-center gap-2 text-destructive">
            <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-destructive" />
            <span className="sr-only">Recording</span>
            {browser.began && <Elapsed since={browser.began} />}
            {browser.mic === "on" && <VoiceWave level={browser.level} />}
          </span>
        ) : (
          <>
            <GlobeIcon className="size-4 text-muted-foreground max-lg:hidden" />
            <span className="text-sm font-medium">Browser</span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <LiveDot />
              Live
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          {browser.showing ? (
            <>
              <Button
                size="icon"
                variant={browser.mic === "muted" ? "secondary" : "ghost"}
                onClick={browser.toggleMic}
                className="size-8 max-sm:size-10"
                title={micLabel}
                aria-label={micLabel}
                aria-pressed={browser.mic === "muted"}
              >
                {browser.mic === "on" ? <MicIcon className="size-4" /> : <MicOffIcon className="size-4" />}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => browser.endShowing(false)} className="h-8 rounded-full max-sm:h-10">
                Cancel
              </Button>
              <Button size="sm" onClick={() => browser.endShowing(true)} className="h-8 rounded-full max-sm:h-10">
                Done
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => setAsking(true)} className="h-8 gap-1.5 rounded-full max-sm:size-10 max-sm:px-0" title="Show Emplio how">
                <CircleDotIcon className="size-3.5 max-sm:size-4" />
                <span className="max-sm:sr-only">Show Emplio how</span>
              </Button>
              <Button
                size="sm"
                variant={control ? "default" : "outline"}
                onClick={() => takeControl(!control)}
                title={control ? "Stop controlling" : "Take control"}
                className={`h-8 gap-1.5 rounded-full transition-shadow max-sm:size-10 max-sm:px-0 ${nudged ? "ring-2 ring-primary/50 ring-offset-2 ring-offset-background" : ""}`}
              >
                {control ? <EyeIcon className="size-3.5 max-sm:size-4" /> : <MousePointerClickIcon className="size-3.5 max-sm:size-4" />}
                <span className="max-sm:sr-only">{control ? "Stop controlling" : "Take control"}</span>
              </Button>
              {/* one X, then ask: people read it as "close this panel", but it used to end the browser too */}
              <Button size="icon" variant="ghost" onClick={() => setClosing(true)} className="size-8 max-sm:size-10" aria-label="Close">
                <XIcon className="size-4" />
              </Button>
            </>
          )}
        </div>
      </header>
      {browser.showing ? (
        <p className="shrink-0 border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {browser.mic === "on"
            ? "Recording your clicks and voice. Talk it through as you go. "
            : browser.mic === "muted"
              ? "Recording your clicks. Your voice is muted. "
              : browser.mic === "blocked"
                ? "Recording your clicks. Your microphone is blocked, so your voice isn't being recorded. "
                : "Recording your clicks. "}
          What you save here really saves. Passwords aren&apos;t recorded.
        </p>
      ) : control && (
        <p className="shrink-0 border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-900 dark:text-amber-200">
          You&apos;re in control. Finish what you need (a login, a code, a CAPTCHA), then tell Emplio to carry on.
        </p>
      )}
      <div className="group relative min-h-0 flex-1 bg-muted/40 p-2 lg:p-3">
        {/* Watching vs control only locks the view (inert): changing the link (readOnly) reloads the live
            view, which reconnects to a blank tab instead of the page the agent was on */}
        <iframe
          src={url}
          title="Live browser"
          allow="autoplay; clipboard-read; clipboard-write"
          inert={!inControl}
          className={`size-full rounded-lg border bg-background ${dragging ? "pointer-events-none" : ""}`}
        />
        {/* watching: the page can't be clicked, so a click says how to use it instead of doing nothing */}
        {!inControl && (
          <div onPointerDown={nudge} onWheel={nudge} className="absolute inset-2 cursor-default lg:inset-3">
            <div
              role="status"
              className={`absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 whitespace-nowrap rounded-full border bg-popover/95 py-1.5 pr-1.5 pl-4 text-sm text-popover-foreground shadow-lg backdrop-blur transition duration-200 ${
                nudged ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-90"
              }`}
            >
              <EyeIcon className="size-4 shrink-0 text-muted-foreground" />
              <span>{nudged ? "Emplio is using this browser" : "You're watching"}</span>
              <Button
                size="sm"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => takeControl(true)}
                className="h-7 gap-1.5 rounded-full"
              >
                <MousePointerClickIcon className="size-3.5" />
                Take control
              </Button>
            </div>
          </div>
        )}
      </div>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Record your voice too?</AlertDialogTitle>
            <AlertDialogDescription>
              Do the task once in this browser and Emplio will learn it. Talking it through helps Emplio understand why you do each step. You can mute anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              onClick={() => {
                setAsking(false);
                void browser.startShowing(false);
              }}
            >
              Clicks only
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                setAsking(false);
                void browser.startShowing(true);
              }}
            >
              <MicIcon className="size-4" />
              Record voice
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={closing} onOpenChange={setClosing}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close the browser?</AlertDialogTitle>
            <AlertDialogDescription>
              <b>Hide</b> just puts it away, and Emplio keeps working in it. Bring it back anytime from{" "}
              &ldquo;Live browser&rdquo;.
              <br />
              <br />
              <b>Stop</b> closes it and every page in it. Anything you signed in to stays signed in for next time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setClosing(false);
                browser.close();
              }}
            >
              Stop browser
            </AlertDialogAction>
            <AlertDialogAction
              variant="default"
              onClick={() => {
                setClosing(false);
                browser.hide();
              }}
            >
              Hide
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </>
      )}
    </SidePanel>
  );
}

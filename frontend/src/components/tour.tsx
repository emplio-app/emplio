"use client";

// Short tours, each shown the first time its part of the app is on screen (Orca's "contextual tours"): the chat's
// right after the welcome dialog, Work's when Work first opens, the menu's when the menu first opens, and so on. Each
// is a few steps with Back / Next; the app stays usable underneath. A step points at the real
// thing, marked data-tip="<id>" (data-tip-side: which side the bubble sits), and one whose thing isn't on screen is
// left out. Only for people who came through the welcome dialog; all of them again from the account menu (Product tour).
import { Popover } from "@base-ui/react/popover";
import { track } from "@cloud/client";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type Step = { title: string; body: string; at: string };
type TourDef = { id: string; when: () => boolean; steps: Step[] };

const tip = (id: string) => `[data-tip="${id}"]`;
const on = (re: RegExp) => () => re.test(location.pathname);

const TOURS: TourDef[] = [
  {
    id: "chat",
    when: on(/^\/(chat|home)/),
    steps: [
      {
        title: "This is your chat with Emplio",
        body: "Give it work here, typed or spoken, like messaging a colleague. It checks with you before anything risky.",
        at: tip("chat"),
      },
      {
        title: "Work",
        body: "Every job Emplio is doing, and tasks for you and your team.",
        at: tip("work"),
      },
      {
        title: "Memory",
        body: "What Emplio has learned about your business, plus its files and tables.",
        at: tip("memory"),
      },
      {
        title: "Team",
        body: "The people you work with. Each gets their own chat with Emplio.",
        at: tip("team"),
      },
      {
        title: "Your menu",
        body: "Connect your apps, set up automations, reach Emplio on Telegram or WhatsApp, and more.",
        at: `${tip("account")}, ${tip("menu")}`,
      },
    ],
  },
  {
    id: "work",
    when: on(/^\/tasks/),
    steps: [
      {
        title: "Work in one place",
        body: "Follow each job, approve what's waiting on you, and add tasks for yourself, your team or Emplio.",
        at: tip("work-page"),
      },
    ],
  },
  {
    id: "task",
    when: () => !!document.querySelector(`${tip("t-work")}, ${tip("t-start")}`),
    steps: [
      {
        title: "Watch Emplio work",
        body: "Opens the chat where Emplio does this job, so you can follow each step and jump in.",
        at: tip("t-work"),
      },
      {
        title: "Start it now",
        body: "Emplio picks it up straight away instead of waiting for its due date. You'll see it in a chat.",
        at: tip("t-start"),
      },
    ],
  },
  {
    id: "job",
    when: () => !!document.querySelector(tip("job")),
    steps: [
      {
        title: "Emplio handed this to an agent",
        body: "An agent is doing this job for Emplio. Tap here to see each step it takes, or open its chat to follow along.",
        at: tip("job"),
      },
    ],
  },
  {
    id: "made",
    when: () => !!document.querySelector(tip("made")),
    steps: [
      {
        title: "Emplio made you a file",
        body: "Tap it to open it beside the chat, or download it straight away.",
        at: tip("made"),
      },
    ],
  },
  {
    id: "file",
    when: () => !!document.querySelector(tip("file-share")),
    steps: [
      {
        title: "Share it with a link",
        body: "Make a link anyone can open, no sign-in needed. Every file Emplio makes is also kept in Memory, under Files.",
        at: tip("file-share"),
      },
    ],
  },
  {
    id: "approve",
    when: () => !!document.querySelector(tip("approve")),
    steps: [
      {
        title: "Emplio asks first",
        body: "Before it sends or changes anything in your apps, it waits for you. Allow runs it once, Always allow stops asking for this, Deny stops it.",
        at: tip("approve"),
      },
    ],
  },
  {
    id: "memory",
    when: on(/^\/(knowledge|files|database)/),
    steps: [
      {
        title: "What Emplio knows",
        body: "Notes about your business, plus its files and tables. If something's wrong, fix it here or tell Emplio in chat.",
        at: tip("memory-page"),
      },
    ],
  },
  {
    id: "team",
    when: on(/^\/team/),
    steps: [
      {
        title: "Bring your team in",
        body: "Add the people you work with. They give Emplio work in their own chats, and it knows who's who.",
        at: `${tip("team-add")}, ${tip("team-page")}`,
      },
    ],
  },
  {
    id: "menu",
    when: () => !!document.querySelector(tip("m-automations")),
    steps: [
      {
        title: "Integrations",
        body: "Connect the apps you already use, so Emplio can work in them for you.",
        at: tip("m-apps"),
      },
      {
        title: "Automations",
        body: "Work Emplio repeats on a schedule, like a Monday sales summary. Ask for one in chat and it shows up here.",
        at: tip("m-automations"),
      },
      {
        title: "Channels",
        body: "Reach Emplio on Telegram or WhatsApp too. Same Emplio, same memory.",
        at: tip("m-channels"),
      },
      {
        title: "Passwords & keys",
        body: "Sign-ins Emplio uses on websites, stored safely. Add one here, or when Emplio asks for it.",
        at: tip("m-logins"),
      },
    ],
  },
  {
    id: "apps",
    when: () => !!document.querySelector(tip("apps")),
    steps: [
      {
        title: "Connect your apps",
        body: "Find an app, tap Connect and sign in. Emplio then works in it for you.",
        at: tip("apps"),
      },
    ],
  },
];

// on: came through the welcome dialog and didn't skip; seen: tours finished or closed
type State = { on: boolean; seen: string[] };
const KEY = "emplio-tours";
const CHANGED = "emplio-tour-changed";
// ponytail: kept per device; a column on users if it ever has to follow them around
function load(): State {
  try {
    return {
      on: false,
      seen: [],
      ...JSON.parse(localStorage.getItem(KEY) ?? "{}"),
    };
  } catch {
    return { on: false, seen: [] };
  }
}
function save(s: State) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
  dispatchEvent(new Event(CHANGED));
}
export function startTour() {
  track("tour_started");
  save({ on: true, seen: [] });
}
export function skipTour() {
  save({ on: false, seen: [] });
}

// sheets, dialogs, menus and the phone's side menu: while one is open, only a step inside it shows
const PANELS =
  '[data-slot="dialog-content"], [data-slot="sheet-content"], [data-slot="dropdown-menu-content"], [data-slot="popover-content"], [data-slot="sidebar"][data-mobile]';

function onScreen(el: Element) {
  if (el.closest("[hidden], [inert], [aria-hidden=true]")) return false;
  const r = el.getBoundingClientRect();
  if (
    !r.width ||
    !r.height ||
    r.bottom <= 0 ||
    r.right <= 0 ||
    r.top >= innerHeight ||
    r.left >= innerWidth
  )
    return false;
  return (
    el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ??
    true
  );
}
// on screen and not under something open (the tour's own bubble doesn't count)
function find(at: string): HTMLElement | null {
  const panels = [...document.querySelectorAll(PANELS)].filter(
    (p) => !p.closest("[data-tour]"),
  );
  const top = panels[panels.length - 1];
  for (const sel of at.split(", ")) {
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find(
      (e) => onScreen(e) && (!top || top.contains(e)),
    );
    if (el) return el;
  }
  return null;
}
const visible = (t: TourDef) =>
  t.steps.flatMap((s, i) => (find(s.at) ? [i] : []));

export function Tour() {
  const [state, setState] = useState<State>({ on: false, seen: [] });
  const [active, setActive] = useState<{ tour: number; step: number } | null>(
    null,
  );
  const [el, setEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const read = () => (setState(load()), setActive(null), setEl(null));
    read();
    addEventListener(CHANGED, read);
    addEventListener("storage", read);
    return () => (
      removeEventListener(CHANGED, read),
      removeEventListener("storage", read)
    );
  }, []);

  const end = (how: "done" | "skipped") => {
    if (!active) return;
    const id = TOURS[active.tour].id;
    track(how === "done" ? "tour_finished" : "tour_skipped", {
      tour: id,
      step: active.step,
    });
    save({ ...state, seen: [...state.seen, id] });
  };
  const endRef = useRef(end);
  endRef.current = end;

  // ponytail: looks a few times a second instead of watching the page; a few lookups are nothing.
  // a place has to hold still a moment first, so a page or menu finishes coming in and nothing flashes
  useEffect(() => {
    if (!state.on) return;
    let last: Element | null = null;
    let since = 0;
    let missing = Date.now();
    const settle = (found: HTMLElement | null, show: () => void) => {
      if (found !== last) return void ((last = found), (since = Date.now()));
      if (found && Date.now() - since >= 400) show();
    };
    const timer = setInterval(() => {
      if (!active) {
        // a tour not yet seen whose part of the app is on screen now
        const i = TOURS.findIndex(
          (t) => !state.seen.includes(t.id) && t.when() && visible(t).length,
        );
        if (i < 0) return void (last = null);
        const step = visible(TOURS[i])[0];
        return settle(find(TOURS[i].steps[step].at), () =>
          setActive({ tour: i, step }),
        );
      }
      const t = TOURS[active.tour];
      // they left that part of the app (another page, the menu closed): this tour is over
      if (!t.when()) return endRef.current("done");
      const found = find(t.steps[active.step].at);
      if (!found) {
        setEl(null);
        last = null;
        if (Date.now() - missing > 1200) {
          const next = visible(t).find((i) => i > active.step);
          if (next === undefined) endRef.current("done");
          else setActive({ ...active, step: next });
        }
        return;
      }
      missing = Date.now();
      settle(found, () => setEl((old) => (old === found ? old : found)));
    }, 250);
    return () => clearInterval(timer);
  }, [state, active]);

  // what the step points at breathes a soft ring (globals.css)
  useEffect(() => {
    if (!el) return;
    el.dataset.tipActive = "";
    return () => void delete el.dataset.tipActive;
  }, [el]);

  if (!active || !el) return null;
  const t = TOURS[active.tour];
  const s = t.steps[active.step];
  const steps = visible(t);
  const at = Math.max(0, steps.indexOf(active.step));
  const last = at >= steps.length - 1;
  const move = (i: number | undefined) =>
    i === undefined
      ? end("done")
      : (setEl(null), setActive({ ...active, step: i }));
  const side =
    (el.dataset.tipSide as "top" | "bottom" | "left" | "right" | undefined) ??
    "top";
  return (
    <>
      <Spotlight el={el} />
      {/* not modal: the page stays usable while it shows */}
      <Popover.Root open modal={false}>
        {/* inside an open sheet or menu it lives there, so tapping it doesn't close that */}
        <Popover.Portal
          container={el.closest<HTMLElement>(PANELS) ?? undefined}
        >
          <Popover.Positioner
            anchor={el}
            side={side}
            sideOffset={12}
            collisionPadding={12}
            className="z-50"
            data-tour=""
          >
            <Popover.Popup
              key={`${t.id}-${active.step}`}
              initialFocus={false}
              finalFocus={false}
              className="relative w-[min(20rem,calc(100vw-1.5rem))] origin-(--transform-origin) rounded-2xl border bg-popover p-4 text-popover-foreground shadow-lg shadow-black/10 transition-[opacity,scale] duration-200 ease-out outline-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-opacity"
            >
              <Popover.Arrow className="size-3 rotate-45 bg-popover data-[side=bottom]:-top-[7px] data-[side=bottom]:border-t data-[side=bottom]:border-l data-[side=left]:-right-[7px] data-[side=left]:border-t data-[side=left]:border-r data-[side=right]:-left-[7px] data-[side=right]:border-b data-[side=right]:border-l data-[side=top]:-bottom-[7px] data-[side=top]:border-r data-[side=top]:border-b" />
              <Popover.Title className="text-sm font-medium">
                {s.title}
              </Popover.Title>
              <Popover.Description className="mt-1 text-sm text-muted-foreground">
                {s.body}
              </Popover.Description>
              <div className="mt-3 flex items-center gap-2">
                {steps.length > 1 && (
                  <div
                    className="flex items-center gap-2"
                    aria-label={`Step ${at + 1} of ${steps.length}`}
                  >
                    <span className="flex items-center gap-1.5" aria-hidden>
                      {steps.map((i, n) => (
                        <span
                          key={i}
                          className={`block h-1.5 rounded-full transition-all duration-200 ${n === at ? "w-4 bg-foreground" : n < at ? "w-1.5 bg-foreground/55" : "w-1.5 bg-foreground/20"}`}
                        />
                      ))}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {at + 1} of {steps.length}
                    </span>
                  </div>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                  {at > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => move(steps[at - 1])}
                    >
                      <ArrowLeftIcon />
                      Back
                    </Button>
                  )}
                  <Button size="sm" onClick={() => move(steps[at + 1])}>
                    {last ? (steps.length > 1 ? "Done" : "Got it") : "Next"}
                  </Button>
                </div>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}

// the rest of the screen dims a little around what the step points at (taps still go through)
function Spotlight({ el }: { el: HTMLElement }) {
  const [r, setR] = useState(() => el.getBoundingClientRect());
  useEffect(() => {
    let raf = 0;
    const follow = () => {
      raf = requestAnimationFrame(follow);
      setR((o) => {
        const n = el.getBoundingClientRect();
        return n.x === o.x &&
          n.y === o.y &&
          n.width === o.width &&
          n.height === o.height
          ? o
          : n;
      });
    };
    follow();
    return () => cancelAnimationFrame(raf);
  }, [el]);
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-40 rounded-xl shadow-[0_0_0_9999px_rgb(0_0_0/0.22)] transition-[top,left,width,height] duration-200 animate-in fade-in-0 motion-reduce:transition-none"
      style={{
        top: r.top - 6,
        left: r.left - 6,
        width: r.width + 12,
        height: r.height + 12,
      }}
    />
  );
}

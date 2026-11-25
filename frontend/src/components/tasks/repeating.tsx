"use client";

import { useQuery } from "@tanstack/react-query";
import type { Automation } from "@emplio/shared";
import { Building2Icon, RepeatIcon, ZapIcon } from "lucide-react";
import { useState } from "react";
import { AutomationsDialog } from "@/components/chat/automations-dialog";
import { api, useMe } from "@/lib/api";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const time = (h: string, m: string) => new Date(2000, 0, 1, +h, +m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// A schedule in plain words for the common shapes; the rest just "On a schedule".
// ponytail: five cron shapes cover what Emplio writes; a cron library if owners see "On a schedule" often
export function everyWords(cron: string) {
  const [m, h, dom, mon, dow] = cron.trim().split(/\s+/);
  if (!m || !h || !/^\d+$/.test(m) || !/^\d+$/.test(h)) return "On a schedule";
  const at = time(h, m);
  if (/^\d+$/.test(dom!) && /^\d+$/.test(mon!) && dow === "*")
    return `Every year on ${new Date(2000, +mon! - 1, +dom!).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  if (/^\d+$/.test(dom!) && /^\d+(,\d+){3}$/.test(mon!) && dow === "*") return `Every quarter on day ${dom}`;
  if (mon !== "*") return "On a schedule";
  if (dom === "*" && dow === "*") return `Every day at ${at}`;
  if (dom === "*" && dow === "1-5") return `Weekdays at ${at}`;
  if (dom === "*" && /^[0-6]$/.test(dow!)) return `Every ${DAYS[+dow!]} at ${at}`;
  if (/^\d+$/.test(dom!) && dow === "*") return `Monthly on day ${dom} at ${at}`;
  return "On a schedule";
}

const whenWords = (a: Automation) =>
  a.when === "schedule"
    ? everyWords(a.schedule ?? "")
    : a.when === "new client"
      ? "For each new client"
      : `When ${(a.trigger ?? "").replace(/^([a-z]+)\./, "$1: ").replace(/_/g, " ")}`;

// The work that repeats or waits for an event (automations underneath), on the Work page under the tasks.
export function Repeating() {
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ["automations"], queryFn: () => api<Automation[]>("/automations") });
  const list = (data ?? []).filter((a) => a.enabled && !a.error && a.when !== "manual");
  if (!list.length) return null;
  return (
    <section className="grid gap-1">
      <h2 className="px-2 font-sans text-xs font-medium tracking-normal text-muted-foreground">
        Repeats <span className="font-normal">{list.length}</span>
      </h2>
      <ul>
        {list.map((a) => (
          <li key={a.name}>
            <button
              type="button"
              onClick={() => setOpen(true)}
              disabled={me?.workspaces[0]?.role === "member"}
              className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-muted/60 disabled:hover:bg-transparent"
            >
              {a.when === "schedule" ? <RepeatIcon className="size-4 shrink-0 text-muted-foreground" /> : <ZapIcon className="size-4 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{a.process ? `Start ${a.process}` : a.prompt.split("\n")[0]}</span>
                <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="truncate">
                    {whenWords(a)}
                    {a.agent ? ` · ${a.agent}` : a.who ? ` · ${a.who}` : ""}
                  </span>
                  {a.clients && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[0.7rem] font-medium text-foreground/80">
                      <Building2Icon className="size-3 text-muted-foreground" />
                      {a.clients.includes("*") ? "Each active client" : `For ${a.clients.length} client${a.clients.length === 1 ? "" : "s"}`}
                    </span>
                  )}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <AutomationsDialog open={open} onOpenChange={setOpen} />
    </section>
  );
}

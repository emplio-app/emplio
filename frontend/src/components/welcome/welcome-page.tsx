"use client";

import type { AppInfo } from "@emplio/shared";
import { afterWelcome } from "@cloud/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, ArrowRightIcon, LayoutGridIcon, PaperclipIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { AttachmentTray, SAY_FILES, SAY_TEXT, useAttachments } from "@/components/chat/attachments";
import { ChannelsPanel } from "@/components/chat/channels-dialog";
import { AppLogo, ConnectButton, ConnectedMark, useConnect, useConnections } from "@/components/chat/connect-card";
import { IntegrationsDialog } from "@/components/chat/integrations-dialog";
import { ABOUT, ImportPanel } from "@/components/import/import-page";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api, meQueryKey, useMe } from "@/lib/api";
import { cn } from "@/lib/utils";

// A new business's first minutes (after signing up, or "New business"): the things a chat does badly (the name,
// files, website, apps, phone, another AI's memory), then the first chat, started as setup (backend setup.ts):
// Emplio introduces itself, reads what was given here and asks only what's still missing. Every step can be
// skipped; leaving halfway is fine too, the first chat still offers setup.

const STEPS = [
  { key: "business", title: "Tell Emplio about your business", help: "A line or two is plenty. Emplio reads your website and files and asks about the rest." },
  { key: "apps", title: "Connect the apps you use", help: "Emplio works in them for you: reads your mail, sends invoices, keeps the calendar. You can add more any time." },
  { key: "phone", title: "Talk to Emplio from your phone", help: "Message it on Telegram like a colleague. It messages you there too, when something's ready or needs your OK." },
  { key: "memory", title: "Used another AI before?", help: ABOUT },
] as const;

// the apps most small businesses start with (backend integrations: searchApps)
const SUGGESTED = ["gmail", "googlecalendar", "googledrive", "googlesheets", "zoho_books", "whatsapp", "slack", "zoho"];

// ponytail: a few countries
const COUNTRIES = ["India", "United States", "United Kingdom", "United Arab Emirates", "Singapore", "Australia", "Canada", "Other"];

export function WelcomePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const business = me?.workspaces[0];
  const [step, setStep] = useState(0);
  const [name, setName] = useState<string | null>(null);
  const [about, setAbout] = useState("");
  const [website, setWebsite] = useState("");
  // the billing country is for good once paid: only assume India from an Indian clock, anyone else says
  const [country, setCountry] = useState(() => (/Kolkata|Calcutta/.test(Intl.DateTimeFormat().resolvedOptions().timeZone) ? "India" : "Other"));
  const attachments = useAttachments();
  const fileInput = useRef<HTMLInputElement>(null);

  // a fresh signup's business is "<name>'s workspace": ask for the real name
  const shownName = name ?? (business?.name.endsWith("'s workspace") ? "" : (business?.name ?? ""));

  const rename = useMutation({
    mutationFn: () => api(`/workspaces/${business!.id}`, { name: shownName.trim() }, "PATCH"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: meQueryKey }),
  });

  const finish = useMutation({
    mutationFn: async () => {
      await api("/setup/redo", {});
      const said = [
        "Let's do the setup.",
        about.trim() && `About us: ${about.trim()}`,
        website.trim() && `Our website: ${website.trim()}`,
        country !== "India" && `We're in ${country === "Other" ? "a country outside India (ask me which)" : country}.`,
        attachments.ready && "I've attached a few files about the business.",
      ].filter(Boolean);
      try {
        sessionStorage.setItem(SAY_TEXT, said.join("\n\n"));
        sessionStorage.setItem(SAY_FILES, JSON.stringify(attachments.take()));
      } catch {}
      const chat = "/chat";
      router.replace((await afterWelcome(country, chat)) ?? chat);
    },
  });

  const next = async () => {
    if (STEPS[step]!.key === "business" && shownName.trim() && shownName.trim() !== business?.name) await rename.mutateAsync();
    if (step < STEPS.length - 1) setStep(step + 1);
    else finish.mutate();
  };
  const busy = rename.isPending || finish.isPending || attachments.uploading;
  const current = STEPS[step]!;
  const last = step === STEPS.length - 1;

  return (
    <main className="flex min-h-dvh flex-col bg-muted/30 pt-(--safe-top)">
      <header className="flex items-center justify-between px-4 py-4 sm:px-8">
        <Logo />
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => finish.mutate()}>
          Skip to chat
        </Button>
      </header>

      <div className="flex flex-1 justify-center px-4 pt-2 pb-10 sm:pt-[8vh]">
        <div className="w-full max-w-xl">
          <div className="mb-6 flex gap-1.5" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
            {STEPS.map((s, i) => (
              <div key={s.key} className={cn("h-1 flex-1 rounded-full transition-colors duration-300", i <= step ? "bg-primary" : "bg-border")} />
            ))}
          </div>

          <div key={current.key} className="rounded-2xl border bg-card p-5 shadow-xl shadow-primary/5 animate-in fade-in slide-in-from-bottom-2 duration-300 sm:p-7">
            <p className="text-xs font-medium text-muted-foreground">
              Step {step + 1} of {STEPS.length}
            </p>
            <h1 className="mt-1 font-heading text-2xl">{current.title}</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">{current.help}</p>

            <div className="mt-6">
              {current.key === "business" && (
                <div className="grid gap-4">
                  <label className="grid gap-1.5 text-sm font-medium">
                    Business name
                    <Input autoFocus value={shownName} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Bluepine Coffee" />
                  </label>
                  <label className="grid gap-1.5 text-sm font-medium">
                    What do you do?
                    <Textarea
                      value={about}
                      onChange={(e) => setAbout(e.target.value)}
                      rows={3}
                      placeholder="We roast specialty coffee and sell it to cafés and online."
                    />
                  </label>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="grid gap-1.5 text-sm font-medium">
                      Website
                      <Input type="url" inputMode="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="bluepinecoffee.com" />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium">
                      Country
                      <Select items={COUNTRIES.map((c) => ({ value: c, label: c }))} value={country} onValueChange={(v) => v && setCountry(v)}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="w-auto min-w-(--anchor-width)">
                          {COUNTRIES.map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                  </div>
                  <div>
                    <input
                      ref={fileInput}
                      type="file"
                      hidden
                      multiple
                      onChange={(e) => {
                        attachments.add([...(e.target.files ?? [])]);
                        e.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => fileInput.current?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        attachments.add([...e.dataTransfer.files]);
                      }}
                      className="flex w-full items-center gap-3 rounded-xl border border-dashed p-3 text-left text-sm transition-colors hover:bg-muted/50"
                    >
                      <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
                        <PaperclipIcon className="size-4 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="font-medium">Add a price list, brochure or catalogue</div>
                        <div className="text-xs text-muted-foreground">Optional. Drop files here or pick them.</div>
                      </div>
                    </button>
                    <div className="-mx-3">
                      <AttachmentTray items={attachments.items} onRemove={attachments.remove} onRetry={attachments.retry} />
                    </div>
                  </div>
                </div>
              )}
              {current.key === "apps" && <Apps />}
              {current.key === "phone" && <ChannelsPanel />}
              {current.key === "memory" && <ImportPanel />}
            </div>

            {(rename.error || finish.error) && <p className="mt-4 text-sm text-destructive">{(rename.error ?? finish.error)!.message}</p>}

            <div className="mt-7 flex items-center gap-2">
              {step > 0 && (
                <Button variant="ghost" disabled={busy} onClick={() => setStep(step - 1)}>
                  <ArrowLeftIcon />
                  Back
                </Button>
              )}
              <Button className="ml-auto" disabled={busy} onClick={() => void next().catch(() => {})}>
                {busy && <Spinner />}
                {last ? "Meet Emplio" : "Continue"}
                {!busy && <ArrowRightIcon />}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function Apps() {
  const connections = useConnections();
  const { connect, connecting, keyDialog } = useConnect();
  const [all, setAll] = useState(false);
  const apps = useQuery({ queryKey: ["apps"], queryFn: () => api<AppInfo[]>("/apps"), staleTime: 60_000 });
  const shown = SUGGESTED.flatMap((key) => apps.data?.find((a) => a.app === key) ?? []);
  const active = new Set((connections.data ?? []).filter((c) => c.status === "active").map((c) => c.app));

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2">
        {apps.isPending
          ? Array.from({ length: 8 }, (_, i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />)
          : shown.map((a) => (
              <div key={a.app} className="flex items-center gap-2.5 rounded-xl border bg-background p-2.5">
                <AppLogo src={a.logo} className="size-8" />
                <div className="min-w-0 flex-1 truncate text-sm font-medium">{a.name}</div>
                {active.has(a.app) ? <ConnectedMark /> : <ConnectButton busy={connecting === a.app} onClick={() => connect(a)} />}
              </div>
            ))}
      </div>
      <Button variant="outline" className="justify-self-start" onClick={() => setAll(true)}>
        <LayoutGridIcon />
        See all apps
      </Button>
      <IntegrationsDialog open={all} onOpenChange={setAll} />
      {keyDialog}
    </div>
  );
}

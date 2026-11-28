"use client";

// The records beyond clients (backend projects.ts, contacts.ts, services.ts): each a list page, and one panel that
// opens one over any page (?open=projects/x) to read and change it. Notes about one stay in its file
// (company/<kind>/<slug>/index.md), opened from the panel's Notes button.
import {
  type Client,
  type ClientDetail,
  type Contact,
  type ContactInput,
  type FieldKind,
  type HistoryEntry,
  MONEY_PERIODS,
  type Money,
  type MoneyPeriod,
  PROJECT_STATUSES,
  type Project,
  type ProjectInput,
  type ProjectStatus,
  type Service,
  type ServiceInput,
  type Task,
  type TeamMember,
} from "@emplio/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon, ArchiveRestoreIcon, ArrowUpRightIcon, BriefcaseIcon, FileTextIcon, FolderKanbanIcon, MoreHorizontalIcon, PlusIcon, SearchIcon, Settings2Icon, UsersIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AskFloat, type Open, PageAsk } from "@/components/chat/composer";
import { Details, History, initials, MatchNote, Monogram, Named, notesFile, PrivateSwitch, useTeam } from "@/components/clients/clients-page";
import { FieldSetup } from "@/components/clients/stage-setup";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CopyButton } from "@/components/clients/copy-button";
import { QUIET, startedText, useStartsProcess } from "@/components/clients/shared";
import { Button } from "@/components/ui/button";
import { ClientPicker } from "@/components/clients/client-picker";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { api, matchIn, recordsQueryKey, useClients, useContacts, useMe, useProcesses, useProjects, useRecord, useSaveRecord, useSaved, useServices } from "@/lib/api";
import { useConfirm } from "@/components/confirm";
import { cn } from "@/lib/utils";
import { dateText, daysAway, dayText, exactDate } from "@/lib/when";

// where a [[kind/name]] link opens in the app; null: a note, opened in Memory
export function thingHref(to: string) {
  const [kind, name, more] = to.split("/");
  if (!name || more) return null;
  if (kind === "clients") return `/clients/${name}`;
  if (kind === "team") return "/team";
  if (kind === "projects" || kind === "contacts" || kind === "services") return `/${kind}?open=${encodeURIComponent(to)}`;
  return null;
}
const notesHref = (kind: string, r: { slug: string; private: boolean }) => `/knowledge?file=${encodeURIComponent(notesFile(kind, r))}`;

export const STATUS: Record<ProjectStatus, string> = { active: "Active", on_hold: "On hold", done: "Done", cancelled: "Cancelled" };
export const statusText = (s: ProjectStatus) => STATUS[s];
const PERIOD: Record<MoneyPeriod, string> = { once: "one-off", monthly: "a month", yearly: "a year", hourly: "an hour" };
const PER: Record<MoneyPeriod, string> = { once: "", monthly: "/mo", yearly: "/yr", hourly: "/h" };
// 18000 INR monthly → ₹18,000/mo; a note alone ("+ GST", "by the hour") when there's no amount
export function moneyText(m: Money & { priceNote?: string | null; feeNote?: string | null }) {
  const note = m.priceNote ?? m.feeNote ?? "";
  if (m.amount === null) return note;
  let n: string;
  try {
    n = new Intl.NumberFormat(undefined, { style: "currency", currency: m.currency ?? "USD", maximumFractionDigits: m.amount % 1 ? 2 : 0 }).format(m.amount);
  } catch {
    n = `${m.amount} ${m.currency ?? ""}`.trim();
  }
  return [n + (m.period ? PER[m.period] : ""), note].filter(Boolean).join(" ");
}

const useRole = () => {
  const role = useMe().data?.workspaces[0]?.role;
  return { admin: !!role && role !== "member" };
};

// A list page's frame, as on Clients: the bar with the menu button, a title with one line under it, then the list.
function Page({ title, summary, action, children }: { title: string; summary: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <AskFloat />
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <span className="px-2 font-sans text-sm font-medium tracking-normal">{title}</span>
      </header>
      <div className="under-tabs flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-5 px-4 py-5 sm:gap-6 sm:py-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="grid gap-1">
              <h1 className="font-heading text-xl font-semibold tracking-tight">{title}</h1>
              <p className="text-sm text-muted-foreground">{summary}</p>
            </div>
            {action}
          </div>
          {children}
        </div>
      </div>
      <RecordSheet />
    </div>
  );
}

export function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <InputGroup>
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {value && (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" onClick={() => onChange("")} aria-label="Clear search">
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

// One row of a list: what it is on the left, its name and a line about it, and its state on the right.
export function Row({ lead, title, meta, right, sub, href, onClick, dim }: { lead: React.ReactNode; title: React.ReactNode; meta?: React.ReactNode; right?: React.ReactNode; sub?: React.ReactNode; href?: string; onClick?: () => void; dim?: boolean }) {
  const body = (
    <>
      {lead}
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="line-clamp-2 text-sm font-medium sm:truncate">{title}</span>
        {meta && <span className="truncate text-xs text-muted-foreground">{meta}</span>}
      </span>
      {(right || sub) && (
        // ponytail: capped at 40% and cut short, so a long price note never squeezes the name
        <span className="flex max-w-[40%] min-w-0 flex-col items-end gap-0.5 text-right text-xs tabular-nums *:max-w-full *:truncate">
          {right}
          {sub && <span className="text-muted-foreground">{sub}</span>}
        </span>
      )}
    </>
  );
  const cls = cn(
    "flex min-h-14 w-full items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-muted focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none",
    dim && "opacity-60",
  );
  return href ? (
    <Link href={href} scroll={false} className={cls}>
      {body}
    </Link>
  ) : (
    <Button variant="ghost" onClick={onClick} className={cn("h-auto justify-start whitespace-normal font-normal", cls)}>
      {body}
    </Button>
  );
}

export const Section = ({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) => (
  <section className="grid gap-1.5">
    <h2 className="flex items-baseline gap-1.5 px-2.5 font-sans text-xs font-medium tracking-normal text-muted-foreground">
      {title}
      {count !== undefined && <span className="tabular-nums opacity-70">{count}</span>}
    </h2>
    <ul className="grid gap-0.5">{children}</ul>
  </section>
);

export const Avatar = ({ name }: { name: string }) => (
  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary" aria-hidden>
    {initials(name)}
  </span>
);

const Loading = () => (
  <div className="grid gap-2">
    {Array.from({ length: 6 }, (_, i) => (
      <Skeleton key={i} className="h-14 w-full rounded-xl" />
    ))}
  </div>
);

function Empty({ icon: Icon, title, children }: { icon: typeof UsersIcon; title: string; children: React.ReactNode }) {
  return (
    <div className="grid justify-items-center gap-2 rounded-xl border border-dashed px-6 py-14 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </span>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-sm text-pretty text-muted-foreground">{children}</p>
    </div>
  );
}

// a project's due as words (under a "Due" heading), coloured only when it needs a look: late in red, this week in full colour
export function Due({ due, done }: { due?: string; done?: boolean }) {
  if (!due) return null;
  const n = daysAway(due);
  return (
    <span title={exactDate(due)} className={cn(done || n > 7 ? "text-muted-foreground" : n < 0 ? "font-medium text-destructive" : "font-medium text-foreground")}>
      {done ? dateText(due) : dayText(due, { late: true })}
    </span>
  );
}

const useOpen = () => {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return {
    open: params.get("open"),
    show: (path: string) => router.push(`${pathname}?open=${encodeURIComponent(path)}`, { scroll: false }),
    close: () => {
      const rest = new URLSearchParams(params);
      rest.delete("open");
      router.replace(rest.size ? `${pathname}?${rest}` : pathname, { scroll: false });
    },
  };
};

// every word somewhere in its name or any of its fields
export const matches = (words: string[], ...text: (string | null | undefined)[]) => words.every((w) => text.join(" ").toLowerCase().includes(w));
const wordsOf = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

const TileIcon = ({ icon: Icon }: { icon: typeof UsersIcon }) => (
  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
    <Icon className="size-4 text-muted-foreground" />
  </span>
);

// a list's "Show archived" switch, at its foot
function ArchivedToggle({ on, onChange, what }: { on: boolean; onChange: (on: boolean) => void; what: string }) {
  return (
    <Button variant="ghost" size="sm" className="justify-self-center text-muted-foreground" onClick={() => onChange(!on)}>
      <ArchiveIcon />
      {on ? `Back to ${what}` : `Archived ${what}`}
    </Button>
  );
}

// --- pickers

// one client, typed to find among many (the tasks' picker)
const clientItems = (clients: Client[], none = "Pick a client") => [{ value: "", label: none }, ...clients.map((c) => ({ value: c.slug, label: c.name }))];

function Choose<T extends string>({ value, items, label, onChange, disabled, className }: { value: T; items: { value: T; label: string }[]; label: string; onChange: (v: T) => void; disabled?: boolean; className?: string }) {
  return (
    <Select items={items} value={value} disabled={disabled} onValueChange={(v) => (v ?? "") !== value && onChange((v ?? "") as T)}>
      <SelectTrigger size="sm" aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
const teamItems = (team: TeamMember[]) => [{ value: "", label: "Nobody" }, ...team.map((m) => ({ value: m.id, label: m.name ?? m.email }))];
const serviceItems = (services: Service[]) => [{ value: "", label: "No service" }, ...services.map((s) => ({ value: s.slug, label: s.name }))];
const PERIODS = [{ value: "" as const, label: "—" }, ...MONEY_PERIODS.map((p) => ({ value: p, label: PERIOD[p] }))];
const STATUSES = PROJECT_STATUSES.map((s) => ({ value: s, label: STATUS[s] }));

// text saved when the box is left (Enter too); "" clears it
function Text({ value, label, onSave, type = "text", placeholder, disabled, className }: { value: string | null; label: string; onSave: (v: string | null) => void; type?: string; placeholder?: string; disabled?: boolean; className?: string }) {
  const [v, setV] = useSaved(value ?? "");
  return (
    <div className="group relative">
      <Input
        aria-label={label}
        type={type}
        value={v}
        disabled={disabled}
        placeholder={placeholder ?? (disabled ? "—" : "Empty")}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => v.trim() !== (value ?? "") && onSave(v.trim() || null)}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className={cn(QUIET, "w-full truncate placeholder:text-muted-foreground/50 disabled:opacity-100", className)}
      />
      {type !== "date" && <CopyButton value={value ?? ""} label={label} />}
    </div>
  );
}
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <>
    <Label className="truncate font-normal text-muted-foreground">{label}</Label>
    <div className="min-w-0">{children}</div>
  </>
);

// --- list pages

// Owners and admins: the details kept on every record of a kind, beside the list's Add button
function DetailsSetup({ kind, records }: { kind: FieldKind; records: { details: ClientDetail[] }[] }) {
  const { admin } = useRole();
  const [open, setOpen] = useState(false);
  if (!admin) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Settings2Icon />
        Details
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Details on every {kind}</DialogTitle>
            <DialogDescription>The facts you keep on each {kind}, beyond the ones every business has.</DialogDescription>
          </DialogHeader>
          <FieldSetup kind={kind} records={records} />
        </DialogContent>
      </Dialog>
    </>
  );
}

// Every project: one client buying one service. Due soonest first, then the ongoing ones (a retainer has no due).
export function ProjectsPage() {
  const [archived, setArchived] = useState(false);
  const projects = useProjects({ all: true, archived });
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const { show } = useOpen();
  const all = projects.data ?? [];
  const words = wordsOf(query);
  const shown = all.filter((p) => matches(words, p.name, p.client.name, p.lead?.name, p.service?.name, STATUS[p.status], p.feeNote));
  const done = (p: Project) => p.status === "done" || p.status === "cancelled";
  const groups = archived
    ? [{ title: "Archived", list: shown }]
    : [
        { title: "Due", list: shown.filter((p) => p.dueOn && !done(p) && p.status !== "on_hold").sort((a, b) => a.dueOn!.localeCompare(b.dueOn!)) },
        { title: "Ongoing", list: shown.filter((p) => !p.dueOn && p.status === "active") },
        { title: "On hold", list: shown.filter((p) => p.status === "on_hold") },
        { title: "Finished", list: shown.filter(done).sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? "")) },
      ];
  const open = all.filter((p) => !done(p));
  const soon = open.filter((p) => p.dueOn && daysAway(p.dueOn) <= 7).length;
  const late = open.filter((p) => p.dueOn && daysAway(p.dueOn) < 0).length;
  return (
    <Page
      title="Projects"
      summary={
        projects.isPending
          ? "Loading…"
          : archived
            ? `${all.length} archived`
            : open.length
              ? [`${open.length} open`, late && `${late} late`, soon - late > 0 && `${soon - late} due within a week`].filter(Boolean).join(" · ")
              : "Each client buying one service, with who leads it and when it's due."
      }
      action={
        <div className="flex gap-2">
          <DetailsSetup kind="project" records={all} />
          <Button size="sm" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add project
          </Button>
        </div>
      }
    >
      {adding && <AddProject onDone={() => setAdding(false)} />}
      {all.length > 0 && <Search value={query} onChange={setQuery} placeholder="Search projects, clients or people" />}
      {projects.isPending ? (
        <Loading />
      ) : !all.length ? (
        archived ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No archived projects.</p>
        ) : (
          <Empty icon={FolderKanbanIcon} title="No projects yet">
            Emplio adds one when work is agreed. Or tell it: &ldquo;Northwind&rsquo;s website rebuild starts Monday, Sarah leads, due 31 January.&rdquo;
          </Empty>
        )
      ) : !shown.length ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No projects match &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        groups.map(
          (g) =>
            g.list.length > 0 && (
              <Section key={g.title} title={g.title} count={g.list.length}>
                {g.list.map((p) => (
                  <li key={p.id}>
                    <Row
                      onClick={() => show(`projects/${p.slug}`)}
                      dim={done(p) || !!p.archivedAt}
                      lead={<Monogram c={p.client} size="sm" />}
                      title={<Named name={p.name} private={p.private} />}
                      meta={[p.client.name, p.lead && `${p.lead.name} leads`, p.openTasks && `${p.openTasks} open`].filter(Boolean).join(" · ")}
                      right={done(p) ? <span className="text-muted-foreground">{STATUS[p.status]}</span> : <Due due={p.dueOn ?? undefined} />}
                      sub={moneyText(p)}
                    />
                  </li>
                ))}
              </Section>
            ),
        )
      )}
      {!projects.isPending && <ArchivedToggle on={archived} onChange={setArchived} what="projects" />}
    </Page>
  );
}

function AddProject({ onDone }: { onDone: () => void }) {
  const clients = useClients().data ?? [];
  const services = useServices().data ?? [];
  const { show } = useOpen();
  const [f, setF] = useState({ name: "", client: "", service: "" });
  const add = useSaveRecord((force: boolean) => api<Project & { started: string | null }>("/projects", { name: f.name, client: f.client, service: f.service || null, force }), {
    silent: true,
    done: (p) => {
      toast.success(`Added ${p.name}`, { description: startedText(p.started) });
      onDone();
      show(`projects/${p.slug}`);
    },
  });
  const match = matchIn(add.error);
  const process = useStartsProcess(services.find((s) => s.slug === f.service));
  return (
    <form
      className="grid gap-2 rounded-xl border bg-background p-2 shadow-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (f.name.trim() && f.client) add.mutate(false);
      }}
      onKeyDown={(e) => e.key === "Escape" && onDone()}
    >
      <Input autoFocus placeholder="Project, e.g. Website rebuild" aria-label="Project name" value={f.name} onChange={(e) => (setF({ ...f, name: e.target.value }), add.reset())} />
      <div className="grid gap-2 sm:grid-cols-2">
        <ClientPicker items={clientItems(clients)} value={f.client} onChange={(client) => client && (setF({ ...f, client }), add.reset())} className="w-full" />
        <Choose value={f.service} items={serviceItems(services)} label="Service" onChange={(service) => setF({ ...f, service })} className="w-full" />
      </div>
      {process && <p className="px-1 text-xs text-muted-foreground">Adding it starts {process} for the client.</p>}
      {match ? (
        <MatchNote match={match} kind="project" href={`?open=${encodeURIComponent(`projects/${match.slug}`)}`} onForce={() => add.mutate(true)} />
      ) : (
        add.error && <p className="text-xs text-destructive">{add.error.message}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!f.name.trim() || !f.client || add.isPending}>
          Add
        </Button>
      </div>
    </form>
  );
}

// Everyone at a client the business deals with: their role there, how to reach them.
export function ContactsPage() {
  const [archived, setArchived] = useState(false);
  const contacts = useContacts({ archived });
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const { show } = useOpen();
  const all = contacts.data ?? [];
  const words = wordsOf(query);
  const shown = all.filter((c) => matches(words, c.name, c.email, c.phone, c.title, c.org, ...c.clients.flatMap((x) => [x.name, x.role])));
  const firms = new Set(all.flatMap((c) => c.clients.map((x) => x.id))).size;
  return (
    <Page
      title="Contacts"
      summary={contacts.isPending ? "Loading…" : archived ? `${all.length} archived` : all.length ? `${all.length} people at ${firms} client${firms === 1 ? "" : "s"}` : "The people you deal with at each client."}
      action={
        <div className="flex gap-2">
          <DetailsSetup kind="contact" records={all} />
          <Button size="sm" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add contact
          </Button>
        </div>
      }
    >
      {adding && <AddContact onDone={() => setAdding(false)} />}
      {all.length > 0 && <Search value={query} onChange={setQuery} placeholder="Search people, clients or roles" />}
      {contacts.isPending ? (
        <Loading />
      ) : !all.length ? (
        archived ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No archived contacts.</p>
        ) : (
          <Empty icon={UsersIcon} title="No contacts yet">
            Emplio adds people as they write in or come up in chats. Or tell it: &ldquo;Emma Brooks is Northwind&rsquo;s finance lead, emma@northwind.example.&rdquo;
          </Empty>
        )
      ) : !shown.length ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Nobody matches &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        <ul className="grid gap-0.5">
          {shown.map((c) => (
            <li key={c.id}>
              <Row
                onClick={() => show(`contacts/${c.slug}`)}
                dim={!!c.archivedAt}
                lead={<Avatar name={c.name} />}
                title={<Named name={c.name} private={c.private} />}
                meta={[c.clients.map((x) => (x.role ? `${x.role}, ${x.name}` : x.name)).join(" · ") || c.org, !c.clients.length && c.title].filter(Boolean).join(" · ")}
                right={c.email ? <span className="hidden max-w-56 truncate text-muted-foreground sm:block">{c.email}</span> : c.phone ? <span className="hidden text-muted-foreground sm:block">{c.phone}</span> : undefined}
              />
            </li>
          ))}
        </ul>
      )}
      {!contacts.isPending && <ArchivedToggle on={archived} onChange={setArchived} what="contacts" />}
    </Page>
  );
}

function AddContact({ onDone }: { onDone: () => void }) {
  const clients = useClients().data ?? [];
  const { show } = useOpen();
  const [f, setF] = useState({ name: "", client: "", role: "", email: "" });
  const add = useSaveRecord(
    (force: boolean) => api<Contact>("/contacts", { name: f.name, email: f.email.trim() || null, clients: f.client ? [{ client: f.client, role: f.role.trim() || null }] : [], force }),
    { silent: true, done: (c) => (toast.success(`Added ${c.name}`), onDone(), show(`contacts/${c.slug}`)) },
  );
  const match = matchIn(add.error);
  return (
    <form
      className="grid gap-2 rounded-xl border bg-background p-2 shadow-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (f.name.trim()) add.mutate(false);
      }}
      onKeyDown={(e) => e.key === "Escape" && onDone()}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Input autoFocus placeholder="Name" aria-label="Name" value={f.name} onChange={(e) => (setF({ ...f, name: e.target.value }), add.reset())} />
        <Input placeholder="Email" type="email" aria-label="Email" value={f.email} onChange={(e) => (setF({ ...f, email: e.target.value }), add.reset())} />
        <ClientPicker items={clientItems(clients, "At which client?")} value={f.client} label="At client" onChange={(client) => setF({ ...f, client })} className="w-full" />
        <Input placeholder="Role there, e.g. Finance lead" aria-label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} />
      </div>
      {match ? (
        <MatchNote match={match} kind="contact" href={`?open=${encodeURIComponent(`contacts/${match.slug}`)}`} onForce={() => add.mutate(true)} />
      ) : (
        add.error && <p className="text-xs text-destructive">{add.error.message}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!f.name.trim() || add.isPending}>
          Add
        </Button>
      </div>
    </form>
  );
}

// What the business offers: each service, its price and the process a project of it runs.
export function ServicesPage() {
  const [archived, setArchived] = useState(false);
  const services = useServices({ archived });
  const processes = useProcesses().data ?? [];
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const { show } = useOpen();
  const all = services.data ?? [];
  const words = wordsOf(query);
  const shown = all.filter((s) => matches(words, s.name, s.priceNote, s.process));
  return (
    <Page
      title="Services"
      summary={services.isPending ? "Loading…" : archived ? `${all.length} archived` : all.length ? `${all.length} service${all.length === 1 ? "" : "s"}` : "What you offer clients, and for how much."}
      action={
        <div className="flex gap-2">
          <DetailsSetup kind="service" records={all} />
          <Button size="sm" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add service
          </Button>
        </div>
      }
    >
      {adding && <AddService onDone={() => setAdding(false)} />}
      {all.length > 0 && <Search value={query} onChange={setQuery} placeholder="Search services" />}
      {services.isPending ? (
        <Loading />
      ) : !all.length ? (
        archived ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No archived services.</p>
        ) : (
          <Empty icon={BriefcaseIcon} title="No services yet">
            Tell Emplio what you offer: &ldquo;Monthly bookkeeping, 800 a month, covers payroll and VAT returns.&rdquo;
          </Empty>
        )
      ) : !shown.length ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No services match &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        <ul className="grid gap-0.5">
          {shown.map((s) => (
            <li key={s.id}>
              <Row
                onClick={() => show(`services/${s.slug}`)}
                dim={!!s.archivedAt}
                lead={<TileIcon icon={BriefcaseIcon} />}
                title={<Named name={s.name} private={s.private} />}
                meta={[s.activeProjects ? `${s.activeProjects} active project${s.activeProjects === 1 ? "" : "s"}` : "No active projects", s.process && `starts ${processes.find((p) => p.name === s.process)?.title ?? s.process}`].filter(Boolean).join(" · ")}
                right={<span className="text-muted-foreground" title={moneyText(s) || undefined}>{moneyText(s) || "No price yet"}</span>}
              />
            </li>
          ))}
        </ul>
      )}
      {!services.isPending && <ArchivedToggle on={archived} onChange={setArchived} what="services" />}
    </Page>
  );
}

function AddService({ onDone }: { onDone: () => void }) {
  const { admin } = useRole();
  const { show } = useOpen();
  const [f, setF] = useState({ name: "", amount: "", period: "" as MoneyPeriod | "" });
  const add = useSaveRecord(
    (force: boolean) => api<Service>("/services", { name: f.name, ...(admin && f.amount.trim() && { amount: f.amount.trim(), period: f.period || null }), force } satisfies ServiceInput & { force: boolean }),
    { silent: true, done: (s) => (toast.success(`Added ${s.name}`), onDone(), show(`services/${s.slug}`)) },
  );
  const match = matchIn(add.error);
  return (
    <form
      className="grid gap-2 rounded-xl border bg-background p-2 shadow-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (f.name.trim()) add.mutate(false);
      }}
      onKeyDown={(e) => e.key === "Escape" && onDone()}
    >
      <div className={cn("grid gap-2", admin && "sm:grid-cols-[minmax(0,1fr)_8rem_8rem]")}>
        <Input autoFocus placeholder="Service, e.g. Monthly bookkeeping" aria-label="Service name" value={f.name} onChange={(e) => (setF({ ...f, name: e.target.value }), add.reset())} />
        {admin && (
          <>
            <Input placeholder="Price" aria-label="Price" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
            <Choose value={f.period} items={PERIODS} label="Per" onChange={(period) => setF({ ...f, period })} className="w-full" />
          </>
        )}
      </div>
      {match ? (
        <MatchNote match={match} kind="service" href={`?open=${encodeURIComponent(`services/${match.slug}`)}`} onForce={() => add.mutate(true)} />
      ) : (
        add.error && <p className="text-xs text-destructive">{add.error.message}</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!f.name.trim() || add.isPending}>
          Add
        </Button>
      </div>
    </form>
  );
}

// --- the panel

// what the message box calls one that's open (composer.tsx Open)
const OPEN_KIND = { contacts: "contact", projects: "project", services: "service" } as const;
type Kind = keyof typeof OPEN_KIND;

// One record, opened from anywhere (?open=projects/x): every field to change in place, its open work, its history.
export function RecordSheet() {
  const { open, close } = useOpen();
  const [kind, slug, more] = (open ?? "").split("/");
  const known = !more && !!slug && kind! in OPEN_KIND;
  return (
    <Sheet open={known} onOpenChange={(o) => !o && close()}>
      <SheetContent className="w-full gap-0 overflow-x-hidden sm:max-w-md">
        {known && kind === "projects" && <ProjectPanel slug={slug!} />}
        {known && kind === "contacts" && <ContactPanel slug={slug!} />}
        {known && kind === "services" && <ServicePanel slug={slug!} />}
      </SheetContent>
    </Sheet>
  );
}

// a record kept after saving (the answer has its new updatedAt), so a second change right after isn't refused as stale
function useKeep<T>(kind: Kind, slug: string, key: string) {
  const qc = useQueryClient();
  return (out: T) => qc.setQueryData([...recordsQueryKey, kind, "one", slug], (old: Record<string, unknown> | undefined) => old && { ...old, [key]: out });
}

function Panel({
  kind,
  slug,
  private: on,
  title,
  sub,
  lead,
  archivedAt,
  onArchive,
  footer,
  history,
  children,
}: {
  kind: Kind;
  slug: string;
  private: boolean;
  title: string;
  sub: React.ReactNode;
  lead: React.ReactNode;
  archivedAt: string | null;
  onArchive?: (archive: boolean) => void;
  footer?: React.ReactNode;
  history: HistoryEntry[];
  children: React.ReactNode;
}) {
  return (
    <>
      <SheetHeader className="gap-3 border-b pr-12">
        <div className="flex items-center gap-3">
          {lead}
          <div className="grid min-w-0 gap-0.5">
            <SheetTitle className="truncate font-heading text-lg font-semibold">{title}</SheetTitle>
            <SheetDescription className="truncate">{sub}</SheetDescription>
          </div>
        </div>
      </SheetHeader>
      <div className="grid flex-1 content-start gap-6 overflow-y-auto p-4">
        {archivedAt && (
          <p className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
            <ArchiveIcon className="size-4" />
            Archived {dateText(archivedAt.slice(0, 10))}
          </p>
        )}
        {children}
        <History entries={history} />
      </div>
      <SheetFooter className="flex-row items-center gap-2 border-t">
        <Button variant="outline" size="sm" nativeButton={false} render={<Link href={notesHref(kind, { slug, private: on })} />}>
          <FileTextIcon />
          Notes
        </Button>
        {onArchive && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="More" />}>
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuItem onClick={() => onArchive(!archivedAt)}>
                {archivedAt ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                {archivedAt ? "Bring back" : "Archive"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {footer}
      </SheetFooter>
      <PageAsk sheet open={{ kind: OPEN_KIND[kind] as Open["kind"], title, ref: notesFile(kind, { slug, private: on }) }} />
    </>
  );
}

function PanelLoading({ pending }: { pending: boolean }) {
  return (
    <div className="grid gap-3 p-4 pt-12">
      <SheetTitle className="sr-only">Loading</SheetTitle>
      {pending ? <Skeleton className="h-12 w-2/3" /> : <p className="text-sm text-muted-foreground">This isn&rsquo;t there any more.</p>}
    </div>
  );
}

function ProjectPanel({ slug }: { slug: string }) {
  const q = useRecord<{ project: Project; tasks: Task[] }>("projects", slug);
  const { admin } = useRole();
  const clients = useClients().data ?? [];
  const services = useServices().data ?? [];
  const team = useTeam().data ?? [];
  const keep = useKeep<Project>("projects", slug, "project");
  const p = q.data?.project;
  const save = useSaveRecord((body: ProjectInput) => api<Project>(`/projects/${slug}`, { ...body, updatedAt: p!.updatedAt }, "PATCH"), { done: keep });
  const archive = useSaveRecord((a: boolean) => api<Project>(`/projects/${slug}/${a ? "archive" : "restore"}`, { withWork: true }), { done: keep });
  const [dialog, confirm] = useConfirm();
  if (!p) return <PanelLoading pending={q.isPending} />;
  const open = (q.data?.tasks ?? []).filter((t) => t.status !== "done" && t.status !== "cancelled");
  // open work: asked first, as for a client
  const toArchive = (a: boolean) =>
    a && open.length
      ? confirm({
          title: `Archive ${p.name}?`,
          description: `It still has ${open.length} open task${open.length === 1 ? "" : "s"}. Those stay as they are; ${p.name} leaves your lists. You can bring it back any time.`,
          action: "Archive",
          safe: true,
          onConfirm: () => archive.mutate(true),
        })
      : archive.mutate(a);
  return (
    <Panel
      kind="projects"
      slug={slug}
      private={p.private}
      title={p.name}
      sub={`Project · ${p.client.name}`}
      lead={<Monogram c={p.client} size="lg" />}
      archivedAt={p.archivedAt}
      onArchive={admin ? toArchive : undefined}
      history={q.data!.history}
      footer={
        <Button size="sm" className="ml-auto max-w-[55%]" nativeButton={false} render={<Link href={`/clients/${p.client.slug}`} />}>
          <span className="truncate">{p.client.name}</span>
          <ArrowUpRightIcon />
        </Button>
      }
    >
      {dialog}
      <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 text-sm">
        <Field label="Name">
          <Text value={p.name} label="Name" onSave={(name) => name && save.mutate({ name })} />
        </Field>
        <Field label="Status">
          <Choose value={p.status} items={STATUSES} label="Status" onChange={(status) => save.mutate({ status })} className={cn(QUIET, "w-full")} />
        </Field>
        <Field label="Client">
          {admin ? <ClientPicker items={clientItems(clients)} value={p.client.slug} onChange={(client) => client && client !== p.client.slug && save.mutate({ client })} className={cn(QUIET, "w-full justify-between")} /> : <span className="px-2">{p.client.name}</span>}
        </Field>
        <Field label="Service">
          <Choose value={p.service?.slug ?? ""} items={serviceItems(services)} label="Service" onChange={(service) => save.mutate({ service: service || null })} className={cn(QUIET, "w-full")} />
        </Field>
        <Field label="Lead">
          <Choose value={p.lead?.id ?? ""} items={teamItems(team)} label="Lead" disabled={!admin} onChange={(lead) => save.mutate({ lead: lead || null })} className={cn(QUIET, "w-full")} />
        </Field>
        <Field label="Starts">
          <Text type="date" value={p.startOn} label="Starts" onSave={(startOn) => save.mutate({ startOn })} />
        </Field>
        <Field label="Due">
          <Text type="date" value={p.dueOn} label="Due" onSave={(dueOn) => save.mutate({ dueOn })} />
        </Field>
        <Field label="Fee">
          <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-1">
            <Text value={p.amount === null ? null : String(p.amount)} label="Fee" disabled={!admin} placeholder={admin ? "Amount" : "—"} onSave={(amount) => save.mutate({ amount })} />
            <Choose value={p.period ?? ""} items={PERIODS} label="Fee per" disabled={!admin} onChange={(period) => save.mutate({ period: period || null })} className={cn(QUIET, "w-full")} />
          </div>
        </Field>
        <Field label="Fee note">
          <Text value={p.feeNote} label="Fee note" disabled={!admin} placeholder={admin ? "e.g. + GST, paid quarterly" : "—"} onSave={(feeNote) => save.mutate({ feeNote })} />
        </Field>
        <Details kind="project" details={p.details} onSave={(details) => save.mutate({ details })} />
        <PrivateSwitch on={p.private} because={p.privateBecause} what="Only owners, admins, its client's handlers and its lead see this project. A private client's projects are private with it." onChange={(on) => save.mutate({ private: on })} />
      </div>
      <section className="grid gap-1.5">
        <h2 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">Open work {open.length > 0 && <span className="tabular-nums opacity-60">{open.length}</span>}</h2>
        {open.length ? (
          <ul className="grid gap-0.5">
            {open.map((t) => (
              <li key={t.id}>
                <Link href={`/tasks?task=${t.id}`} className="-mx-2 flex min-h-10 items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-muted">
                  <span className="truncate">{t.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{t.assigneeId ? t.assigneeName : (t.agentName ?? "Emplio")}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing open.</p>
        )}
      </section>
    </Panel>
  );
}

function ContactPanel({ slug }: { slug: string }) {
  const q = useRecord<{ contact: Contact }>("contacts", slug);
  const { admin } = useRole();
  const clients = useClients().data ?? [];
  const keep = useKeep<Contact>("contacts", slug, "contact");
  const c = q.data?.contact;
  const save = useSaveRecord((body: ContactInput) => api<Contact>(`/contacts/${slug}`, { ...body, updatedAt: c!.updatedAt }, "PATCH"), { done: keep });
  const archive = useSaveRecord((a: boolean) => api<Contact>(`/contacts/${slug}/${a ? "archive" : "restore"}`, {}), { done: keep });
  const [linking, setLinking] = useState(false);
  if (!c) return <PanelLoading pending={q.isPending} />;
  const links = c.clients.map((x) => ({ client: x.slug, role: x.role }));
  return (
    <Panel
      kind="contacts"
      slug={slug}
      private={c.private}
      title={c.name}
      sub={["Contact", c.clients[0]?.role ?? c.title, c.clients[0]?.name ?? c.org].filter(Boolean).join(" · ")}
      lead={<span className="grid size-12 shrink-0 place-items-center rounded-full bg-primary/10 text-base font-semibold text-primary">{initials(c.name)}</span>}
      archivedAt={c.archivedAt}
      onArchive={admin ? (a) => archive.mutate(a) : undefined}
      history={q.data!.history}
      footer={
        c.email && (
          <Button size="sm" className="ml-auto max-w-[55%]" nativeButton={false} render={<a href={`mailto:${c.email}`} />}>
            <span className="truncate">Email {c.name.split(" ")[0]}</span>
          </Button>
        )
      }
    >
      <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 text-sm">
        <Field label="Name">
          <Text value={c.name} label="Name" onSave={(name) => name && save.mutate({ name })} />
        </Field>
        <Field label="Email">
          <Text type="email" value={c.email} label="Email" onSave={(email) => save.mutate({ email })} />
        </Field>
        <Field label="Phone">
          <Text type="tel" value={c.phone} label="Phone" onSave={(phone) => save.mutate({ phone })} />
        </Field>
        <Field label="Job title">
          <Text value={c.title} label="Job title" onSave={(title) => save.mutate({ title })} />
        </Field>
        <Field label="Works at">
          <Text value={c.org} label="Works at" placeholder="When it isn't a client" onSave={(org) => save.mutate({ org })} />
        </Field>
        <Details kind="contact" details={c.details} onSave={(details) => save.mutate({ details })} />
        <PrivateSwitch on={c.private} because={c.privateBecause} what="Only owners, admins and the handlers of their clients see this person and their details." onChange={(on) => save.mutate({ private: on })} />
      </div>
      <section className="grid gap-1.5">
        <h2 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">At clients</h2>
        <ul className="grid gap-1">
          {c.clients.map((x) => (
            <li key={x.id} className="group/link grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1 text-sm">
              <Link href={`/clients/${x.slug}`} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 hover:bg-muted">
                <Monogram c={x} size="sm" />
                <span className="truncate">{x.name}</span>
              </Link>
              <Text value={x.role} label={`Role at ${x.name}`} placeholder="Role" onSave={(role) => save.mutate({ clients: links.map((l) => (l.client === x.slug ? { ...l, role } : l)) })} />
              <Button variant="ghost" size="icon-xs" aria-label={`Not at ${x.name}`} onClick={() => save.mutate({ clients: links.filter((l) => l.client !== x.slug) })} className="text-muted-foreground opacity-0 group-hover/link:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100">
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
        {linking ? (
          <ClientPicker
            items={clientItems(clients.filter((x) => !c.clients.some((l) => l.id === x.id)))}
            value=""
            label="Add a client"
            defaultOpen
            onClose={() => setLinking(false)}
            onChange={(client) => (client && save.mutate({ clients: [...links, { client, role: null }] }), setLinking(false))}
            className="w-full"
          />
        ) : (
          <Button variant="ghost" size="sm" className="-ml-2 justify-self-start text-muted-foreground" onClick={() => setLinking(true)}>
            <PlusIcon />
            Add a client
          </Button>
        )}
      </section>
    </Panel>
  );
}

function ServicePanel({ slug }: { slug: string }) {
  const q = useRecord<{ service: Service }>("services", slug);
  const { admin } = useRole();
  const processes = useProcesses().data ?? [];
  const projects = useProjects({}).data ?? [];
  const keep = useKeep<Service>("services", slug, "service");
  const s = q.data?.service;
  const save = useSaveRecord((body: ServiceInput) => api<Service>(`/services/${slug}`, { ...body, updatedAt: s!.updatedAt }, "PATCH"), { done: keep });
  const archive = useSaveRecord((a: boolean) => api<Service>(`/services/${slug}/${a ? "archive" : "restore"}`, {}), { done: keep });
  if (!s) return <PanelLoading pending={q.isPending} />;
  const items = [{ value: "", label: "None" }, ...processes.filter((p) => p.for === "client").map((p) => ({ value: p.name, label: p.title }))];
  const mine = projects.filter((p) => p.service?.id === s.id);
  return (
    <Panel
      kind="services"
      slug={slug}
      private={s.private}
      title={s.name}
      sub={["Service", moneyText(s)].filter(Boolean).join(" · ")}
      lead={<TileIcon icon={BriefcaseIcon} />}
      archivedAt={s.archivedAt}
      onArchive={admin ? (a) => archive.mutate(a) : undefined}
      history={q.data!.history}
    >
      <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 text-sm">
        <Field label="Name">
          <Text value={s.name} label="Name" disabled={!admin} onSave={(name) => name && save.mutate({ name })} />
        </Field>
        <Field label="Price">
          <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-1">
            <Text value={s.amount === null ? null : String(s.amount)} label="Price" disabled={!admin} placeholder={admin ? "Amount" : "—"} onSave={(amount) => save.mutate({ amount })} />
            <Choose value={s.period ?? ""} items={PERIODS} label="Price per" disabled={!admin} onChange={(period) => save.mutate({ period: period || null })} className={cn(QUIET, "w-full")} />
          </div>
        </Field>
        <Field label="Price note">
          <Text value={s.priceNote} label="Price note" disabled={!admin} placeholder={admin ? "e.g. + GST, 80 hours a month" : "—"} onSave={(priceNote) => save.mutate({ priceNote })} />
        </Field>
        <Field label="Starts process">
          <Choose value={s.process ?? ""} items={items} label="Process it runs" disabled={!admin} onChange={(process) => save.mutate({ process: process || null })} className={cn(QUIET, "w-full")} />
        </Field>
        <Details kind="service" details={s.details} disabled={!admin} onSave={(details) => save.mutate({ details })} />
        <PrivateSwitch on={s.private} what="Only owners and admins see this service." onChange={(on) => save.mutate({ private: on })} />
      </div>
      {s.process && <p className="-mt-3 text-xs text-muted-foreground">A new project of {s.name} starts this process for its client.</p>}
      <section className="grid gap-1.5">
        <h2 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">Open projects {mine.length > 0 && <span className="tabular-nums opacity-60">{mine.length}</span>}</h2>
        {mine.length ? (
          <ul className="grid gap-0.5">
            {mine.map((p) => (
              <li key={p.id}>
                <Link href={`?open=${encodeURIComponent(`projects/${p.slug}`)}`} scroll={false} className="-mx-2 flex min-h-10 items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-muted">
                  <span className="truncate">
                    {p.client.name} · {p.name}
                  </span>
                  <Due due={p.dueOn ?? undefined} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None open.</p>
        )}
      </section>
    </Panel>
  );
}

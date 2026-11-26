"use client";

// The company's things beyond clients (backend things.ts): projects and contacts, each a list with a panel that opens
// one, and the same panel for a team member's file. All read from company/<kind>/<name>/index.md; Emplio keeps them,
// so changes go through it (the Notes button opens the file in Memory).
import type { Thing, ThingKind } from "@emplio/shared";
import { ArrowUpRightIcon, FileTextIcon, FolderKanbanIcon, SearchIcon, UsersIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { initials, Monogram } from "@/components/clients/clients-page";
import { Linked } from "@/components/knowledge/knowledge-page";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { useThingPage, useThings } from "@/lib/api";
import { cn } from "@/lib/utils";
import { dateText, daysAway, dayText, exactDate } from "@/lib/when";

// where a [[kind/name]] link opens in the app; null: a note, opened in Memory
export function thingHref(to: string) {
  const [kind, name, more] = to.split("/");
  if (!name || more) return null;
  if (kind === "clients") return `/clients?client=${name}`;
  if (kind === "projects" || kind === "contacts" || kind === "team") return `/${kind}?open=${encodeURIComponent(to)}`;
  return null;
}
const fileHref = (path: string) => `/knowledge?file=${encodeURIComponent(`company/${path}/index.md`)}`;
// the [[kind/name]] links in a field, in order
const linksIn = (v = "") => [...v.matchAll(/\[\[([a-z]+\/[a-z0-9-]+)\]\]/g)].map((m) => m[1]!);
const slugOf = (path: string) => path.split("/")[1]!;
const label = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
const DONE = /^(done|complete|completed|closed|finished|cancell?ed|lost)$/i;

// A list page's frame, as on Clients: the bar with the menu button, a title with one line under it, then the list.
function Page({ title, summary, children }: { title: string; summary: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <span className="px-2 font-sans text-sm font-medium tracking-normal">{title}</span>
      </header>
      <div className="under-tabs min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-5 px-4 py-5 sm:gap-6 sm:py-8">
          <div className="grid gap-1">
            <h1 className="font-heading text-xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">{summary}</p>
          </div>
          {children}
        </div>
      </div>
      <ThingSheet />
    </div>
  );
}

export function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <InputGroup className="h-9">
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
        <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs tabular-nums">
          {right}
          {sub && <span className="text-muted-foreground">{sub}</span>}
        </span>
      )}
    </>
  );
  const cls = cn(
    "flex min-h-14 w-full items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none",
    dim && "opacity-60",
  );
  return href ? (
    <Link href={href} scroll={false} className={cls}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
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
    <div className="grid justify-items-center gap-2 rounded-2xl border border-dashed px-6 py-14 text-center">
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
  return { open: useSearchParams().get("open"), show: (path: string) => router.push(`${pathname}?open=${encodeURIComponent(path)}`, { scroll: false }), close: () => router.replace(pathname, { scroll: false }) };
};

const matches = (words: string[], ...text: (string | undefined)[]) => words.every((w) => text.join(" ").toLowerCase().includes(w));

// Every project: one client buying one service. Due soonest first, then the ongoing ones (a retainer has no due).
export function ProjectsPage() {
  const things = useThings();
  const [query, setQuery] = useState("");
  const { show } = useOpen();
  const titles = new Map((things.data ?? []).map((t) => [t.path, t.title]));
  const name = (to?: string) => (to ? (titles.get(to) ?? label(slugOf(to).replace(/-/g, " "))) : undefined);
  const all = (things.data ?? []).filter((t) => t.kind === "projects");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((p) => matches(words, p.title, name(linksIn(p.fields.client)[0]), name(linksIn(p.fields.lead)[0])));
  const done = (p: Thing) => DONE.test(p.fields.status ?? "");
  const groups = [
    { title: "Due", list: shown.filter((p) => p.fields.due && !done(p)).sort((a, b) => a.fields.due!.localeCompare(b.fields.due!)) },
    { title: "Ongoing", list: shown.filter((p) => !p.fields.due && !done(p)) },
    { title: "Finished", list: shown.filter(done) },
  ];
  const soon = all.filter((p) => p.fields.due && !done(p) && daysAway(p.fields.due) <= 7).length;
  const ongoing = all.filter((p) => !p.fields.due && !done(p)).length;
  return (
    <Page
      title="Projects"
      summary={
        things.isPending
          ? "Loading…"
          : all.length
            ? [`${all.length} project${all.length === 1 ? "" : "s"}`, soon && `${soon} due within a week`, ongoing && `${ongoing} ongoing`].filter(Boolean).join(" · ")
            : "Each client buying one service, with who leads it and when it's due."
      }
    >
      {all.length > 5 && <Search value={query} onChange={setQuery} placeholder="Search projects, clients or people" />}
      {things.isPending ? (
        <Loading />
      ) : !all.length ? (
        <Empty icon={FolderKanbanIcon} title="No projects yet">
          Emplio adds one when work is agreed. Or tell it: &ldquo;Northwind&rsquo;s website rebuild starts Monday, Sarah leads, due 31 January.&rdquo;
        </Empty>
      ) : !shown.length ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No projects match &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        groups.map(
          (g) =>
            g.list.length > 0 && (
              <Section key={g.title} title={g.title} count={g.list.length}>
                {g.list.map((p) => {
                  const client = linksIn(p.fields.client)[0];
                  return (
                    <li key={p.path}>
                      <Row
                        onClick={() => show(p.path)}
                        dim={done(p)}
                        lead={client ? <Monogram c={{ slug: slugOf(client), name: name(client)! }} size="sm" /> : <TileIcon icon={FolderKanbanIcon} />}
                        title={p.title}
                        meta={[name(client), linksIn(p.fields.lead).length ? `${name(linksIn(p.fields.lead)[0])} leads` : "", p.fields.status && !done(p) ? p.fields.status : ""].filter(Boolean).join(" · ")}
                        right={<Due due={p.fields.due} done={done(p)} />}
                        sub={p.fields.fee}
                      />
                    </li>
                  );
                })}
              </Section>
            ),
        )
      )}
    </Page>
  );
}

const TileIcon = ({ icon: Icon }: { icon: typeof UsersIcon }) => (
  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
    <Icon className="size-4 text-muted-foreground" />
  </span>
);

// Everyone at a client the business deals with: their role, how to reach them.
export function ContactsPage() {
  const things = useThings();
  const [query, setQuery] = useState("");
  const { show } = useOpen();
  const titles = new Map((things.data ?? []).map((t) => [t.path, t.title]));
  const all = (things.data ?? []).filter((t) => t.kind === "contacts");
  const clientsOf = (c: Thing) => linksIn(c.fields.client).map((to) => titles.get(to) ?? label(slugOf(to)));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = all.filter((c) => matches(words, c.title, c.fields.role, c.fields.email, ...clientsOf(c)));
  const firms = new Set(all.flatMap((c) => linksIn(c.fields.client))).size;
  return (
    <Page
      title="Contacts"
      summary={things.isPending ? "Loading…" : all.length ? `${all.length} people at ${firms} client${firms === 1 ? "" : "s"}` : "The people you deal with at each client."}
    >
      {all.length > 5 && <Search value={query} onChange={setQuery} placeholder="Search people, clients or roles" />}
      {things.isPending ? (
        <Loading />
      ) : !all.length ? (
        <Empty icon={UsersIcon} title="No contacts yet">
          Emplio adds people as they write in or come up in chats. Or tell it: &ldquo;Emma Brooks is Northwind&rsquo;s finance lead, emma@northwind.example.&rdquo;
        </Empty>
      ) : !shown.length ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Nobody matches &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        <ul className="grid gap-0.5">
          {shown.map((c) => (
            <li key={c.path}>
              <Row
                onClick={() => show(c.path)}
                lead={<Avatar name={c.title} />}
                title={c.title}
                meta={[c.fields.role, clientsOf(c).join(", ")].filter(Boolean).join(" · ")}
                right={c.fields.email ? <span className="hidden max-w-56 truncate text-muted-foreground sm:block">{c.fields.email}</span> : undefined}
              />
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

// how a field that links back reads: Sarah "leads" the project that names her as lead
const AS: Record<string, string> = { handler: "Handles", lead: "Leads", team: "On the team", approver: "Approves", client: "", text: "Mentioned" };
const KIND_LABEL: Record<ThingKind, string> = { clients: "Clients", contacts: "Contacts", team: "Team", services: "Services", projects: "Projects" };
const ONE: Record<ThingKind, string> = { clients: "Client", contacts: "Contact", team: "Team member", services: "Service", projects: "Project" };

// One thing, opened from a list (?open=projects/x): its fields (links as chips that open what they name), its notes,
// and what names it. Changes go through Emplio: Notes opens the file in Memory, with Suggest a change there.
export function ThingSheet() {
  const { open, close } = useOpen();
  const page = useThingPage(open ?? "", !!open);
  const t = page.data?.thing;
  const titles = page.data?.links;
  const client = t && linksIn(t.fields.client)[0];
  // its "# Title" line is the title above
  const body = t?.body.replace(/^#\s+(.+)\n?/, (m, h: string) => (h.trim() === t.title ? "" : m)).trim();
  const kinds = (Object.keys(KIND_LABEL) as ThingKind[]).filter((k) => page.data?.linkedFrom.some((l) => l.kind === k));
  return (
    <Sheet open={!!open} onOpenChange={(o) => !o && close()}>
      <SheetContent className="w-full gap-0 overflow-x-hidden sm:max-w-md">
        {!t ? (
          <div className="grid gap-3 p-4 pt-12">
            <SheetTitle className="sr-only">Loading</SheetTitle>
            {page.isPending ? <Skeleton className="h-12 w-2/3" /> : <p className="text-sm text-muted-foreground">This page isn&rsquo;t there any more.</p>}
          </div>
        ) : (
          <>
            <SheetHeader className="gap-3 border-b pr-12">
              <div className="flex items-center gap-3">
                {t.kind === "projects" && client ? <Monogram c={{ slug: slugOf(client), name: titles?.find((l) => l.to === client)?.title ?? slugOf(client) }} size="lg" /> : <span className="grid size-12 shrink-0 place-items-center rounded-full bg-primary/10 text-base font-semibold text-primary">{initials(t.title)}</span>}
                <div className="grid min-w-0 gap-0.5">
                  <SheetTitle className="truncate font-heading text-lg font-semibold">{t.title}</SheetTitle>
                  <SheetDescription className="truncate">{[ONE[t.kind], t.fields.role].filter(Boolean).join(" · ")}</SheetDescription>
                </div>
              </div>
            </SheetHeader>
            <div className="grid flex-1 content-start gap-6 overflow-y-auto p-4">
              <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-3 text-sm">
                {Object.entries(t.fields)
                  .filter(([k]) => k !== "name")
                  .map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{label(k)}</dt>
                      <dd className="min-w-0 break-words">
                        <Value k={k} v={v} titles={titles} />
                      </dd>
                    </div>
                  ))}
              </dl>
              {body && (
                <section className="grid gap-2">
                  <h2 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">Notes</h2>
                  <div className="text-sm">
                    <MessageResponse>{body}</MessageResponse>
                  </div>
                </section>
              )}
              {kinds.map((kind) => (
                <section key={kind} className="grid gap-1.5">
                  <h2 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">{KIND_LABEL[kind]}</h2>
                  <ul className="grid gap-0.5">
                    {page.data!.linkedFrom
                      .filter((l) => l.kind === kind)
                      .map((l) => (
                        <li key={`${l.from}-${l.field}`}>
                          <Link href={thingHref(l.from) ?? fileHref(l.from)} scroll={false} className="-mx-2 flex min-h-10 items-center justify-between gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none">
                            <span className="truncate">{l.title}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">{AS[l.field] ?? label(l.field)}</span>
                          </Link>
                        </li>
                      ))}
                  </ul>
                </section>
              ))}
            </div>
            <SheetFooter className="flex-row items-center border-t">
              <Button variant="outline" size="sm" nativeButton={false} render={<Link href={fileHref(t.path)} />}>
                <FileTextIcon />
                Notes
              </Button>
              {client && (
                <Button size="sm" className="ml-auto max-w-[60%]" nativeButton={false} render={<Link href={thingHref(client)!} />}>
                  <span className="truncate">{titles?.find((l) => l.to === client)?.title ?? "Client"}</span>
                  <ArrowUpRightIcon />
                </Button>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// a field's value: links as chips, dates in words (exact on hover), email and phone to tap
function Value({ k, v, titles }: { k: string; v: string; titles?: { to: string; title: string | null }[] }) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return <span title={exactDate(v)}>{dateText(v)}</span>;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))
    return (
      <a href={`mailto:${v}`} title={v} className="block truncate underline-offset-4 hover:underline">
        {v}
      </a>
    );
  if (/phone|mobile/.test(k))
    return (
      <a href={`tel:${v.replace(/[^\d+]/g, "")}`} className="underline-offset-4 hover:underline">
        {v}
      </a>
    );
  return <Linked text={v} prefix="company/" titles={titles} hrefOf={thingHref} />;
}

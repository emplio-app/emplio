"use client";

import type { DbRows, DbTable } from "@emplio/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon, DatabaseIcon, DownloadIcon, FilterIcon, LockIcon, SearchIcon, TableIcon, XIcon } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { toast } from "sonner";
import { MemoryTabs } from "@/components/knowledge/memory-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";

type Sort = { column: string; dir: "asc" | "desc" } | null;
type Filters = Record<string, string>;

// key_hint → Key hint, lead_id → Lead ID, api_keys → API keys
const heading = (name: string) =>
  name
    .replaceAll("_", " ")
    .replace(/\b(id|api)\b/gi, (word) => word.toUpperCase())
    .replace(/^./, (first) => first.toUpperCase());

// The readable name, with the real one (what Emplio calls it) on hover.
function Heading({ name, className }: { name: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={className} />}>{heading(name)}</TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}

const query = (table: string, search: string, sort: Sort, filters: Filters) =>
  new URLSearchParams({ table, search, ...(sort && { sort: sort.column, dir: sort.dir }), filters: JSON.stringify(filters) }).toString();

// What's on screen (search, filters and sort included, every page of it) as an Excel file, numbers as numbers.
async function saveExcel(table: string, data: DbRows) {
  const XLSX = await import("xlsx");
  // Excel refuses a cell longer than this
  const rows = data.rows.map((row) => row.map((v) => (typeof v === "string" ? v.slice(0, 32_767) : v)));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([data.columns.map(heading), ...rows]), "Data");
  XLSX.writeFile(book, `${table.replace(/[^\w -]/g, "_")}.xlsx`);
}

// The records Emplio keeps for the business (leads, orders, ...), to look at. View only: changes go through Emplio.
export function DatabasePage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>(null);
  const [filters, setFilters] = useState<Filters>({});
  const words = useDeferredValue(search.trim());
  const shownFilters = useDeferredValue(filters);
  const tables = useQuery({ queryKey: ["database"], queryFn: () => api<DbTable[]>("/database/tables") });
  const page = useQuery({
    queryKey: ["database", open, offset, words, sort, shownFilters],
    queryFn: () => api<DbRows>(`/database/rows?${query(open!, words, sort, shownFilters)}&offset=${offset}`),
    enabled: !!open,
    // same table: keep the rows up while new ones load, or typing in a filter would close it
    placeholderData: (prev, last) => (last?.queryKey[1] === open ? prev : undefined),
  });
  const narrowed = !!words || Object.keys(shownFilters).length > 0;

  const exportExcel = useMutation({
    mutationFn: async () => saveExcel(open!, await api<DbRows>(`/database/export?${query(open!, search.trim(), sort, filters)}`)),
    onError: (error) => toast.error(error.message),
  });

  const makePrivate = useMutation({
    mutationFn: (on: boolean) => api(`/database/tables/${encodeURIComponent(open!)}/private`, { private: on }, "PUT"),
    onError: (error) => toast.error(error.message),
    onSettled: () => qc.invalidateQueries({ queryKey: ["database"] }),
  });
  const current = tables.data?.find((t) => t.name === open);

  const pick = (name: string) => {
    setOpen(name);
    setOffset(0);
    setSearch("");
    setSort(null);
    setFilters({});
  };
  // first click up, second down, third back to how it was
  const sortBy = (column: string) => {
    setOffset(0);
    setSort(sort?.column !== column ? { column, dir: "asc" } : sort.dir === "asc" ? { column, dir: "desc" } : null);
  };
  const filter = (column: string, text: string) => {
    setOffset(0);
    setFilters((now) => {
      const next = { ...now, [column]: text };
      if (!text) delete next[column];
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        {open && (
          <Button size="icon" variant="ghost" className="size-8 md:hidden" aria-label="All tables" onClick={() => setOpen(null)}>
            <ChevronLeftIcon />
          </Button>
        )}
        <h1 className="sr-only">Memory</h1>
        <MemoryTabs />
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className={`under-tabs w-full shrink-0 overflow-y-auto border-r p-3 md:block md:w-64 ${open ? "hidden" : ""}`} aria-label="Tables">
          {tables.isPending && <Skeleton className="h-40 rounded-xl" />}
          {tables.error && <p className="p-2 text-sm text-destructive">{tables.error.message}</p>}
          {tables.data?.length === 0 && <p className="p-2 text-sm text-muted-foreground">No tables yet.</p>}
          {tables.data?.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => pick(t.name)}
              aria-current={open === t.name}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/60 aria-[current=true]:bg-accent aria-[current=true]:font-medium"
            >
              <TableIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <Heading name={t.name} className="min-w-0 flex-1 truncate" />
              {t.private && <LockIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Private" />}
              {t.rows !== null && <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">{t.rows}</span>}
            </button>
          ))}
        </nav>

        <main className={`flex min-w-0 flex-1 flex-col ${open ? "" : "hidden md:flex"}`}>
          {!open ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
              <DatabaseIcon className="size-8 opacity-40" />
              {tables.data?.length === 0 ? "Records Emplio keeps for you, like leads or orders, show up here." : "Pick a table to see it."}
            </div>
          ) : (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-2">
                <div className="relative min-w-0 flex-1 sm:max-w-xs">
                  <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => {
                      setOffset(0);
                      setSearch(e.target.value);
                    }}
                    placeholder="Search this table"
                    aria-label="Search this table"
                    className="h-8 pl-8 text-sm"
                  />
                </div>
                {Object.keys(filters).length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setOffset(0);
                      setFilters({});
                    }}
                  >
                    Clear filters
                  </Button>
                )}
                {current && (
                  <Tooltip>
                    <TooltipTrigger render={<Label className="ml-auto cursor-pointer gap-2 text-sm font-normal" />}>
                      <Switch size="sm" checked={current.private} disabled={makePrivate.isPending} onCheckedChange={(on) => makePrivate.mutate(on)} />
                      Private
                    </TooltipTrigger>
                    <TooltipContent>{current.private ? "Only the owner and admins can use this table" : "Staff can use this table through Emplio"}</TooltipContent>
                  </Tooltip>
                )}
                <Button size="sm" variant="outline" className="shrink-0" disabled={exportExcel.isPending || !page.data?.total} onClick={() => exportExcel.mutate()}>
                  <DownloadIcon /> {exportExcel.isPending ? "Exporting…" : "Export to Excel"}
                </Button>
              </div>

              {page.isPending ? (
                <Skeleton className="m-6 h-64 rounded-xl" />
              ) : page.error ? (
                <p className="p-6 text-sm text-destructive">{page.error.message}</p>
              ) : (
                <>
                  <div className="under-tabs min-h-0 flex-1 overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {page.data.columns.map((c) => (
                            <TableHead key={c} aria-sort={sort?.column === c ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                              <span className="flex items-center gap-1">
                                <Tooltip>
                                  <TooltipTrigger render={<button type="button" onClick={() => sortBy(c)} className="flex items-center gap-1 font-medium hover:underline" />}>
                                    {heading(c)}
                                    {sort?.column === c && (sort.dir === "asc" ? <ArrowUpIcon className="size-3.5" /> : <ArrowDownIcon className="size-3.5" />)}
                                  </TooltipTrigger>
                                  <TooltipContent>{c}</TooltipContent>
                                </Tooltip>
                                <Popover>
                                  <PopoverTrigger
                                    render={<Button size="icon-xs" variant="ghost" aria-label={`Filter ${heading(c)}`} className={filters[c] ? "text-primary" : "text-muted-foreground"} />}
                                  >
                                    <FilterIcon />
                                  </PopoverTrigger>
                                  <PopoverContent align="start" className="w-56 p-2">
                                    <div className="relative">
                                      <Input
                                        autoFocus
                                        value={filters[c] ?? ""}
                                        onChange={(e) => filter(c, e.target.value)}
                                        placeholder={`${heading(c)} contains…`}
                                        aria-label={`${heading(c)} contains`}
                                        className="h-8 pr-8 text-sm"
                                      />
                                      {filters[c] && (
                                        <Button
                                          size="icon-xs"
                                          variant="ghost"
                                          aria-label={`Clear ${heading(c)} filter`}
                                          className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
                                          onClick={() => filter(c, "")}
                                        >
                                          <XIcon />
                                        </Button>
                                      )}
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              </span>
                            </TableHead>
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {page.data.rows.map((row, i) => (
                          <TableRow key={i}>
                            {row.map((v, j) => (
                              <TableCell key={j} title={v === null ? undefined : String(v)} className="max-w-xs truncate">
                                {v ?? <span className="text-muted-foreground">—</span>}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {!page.data.rows.length && <p className="p-6 text-center text-sm text-muted-foreground">{narrowed ? "Nothing matches." : "This table is empty."}</p>}
                  </div>
                  {page.data.total > page.data.limit && (
                    <footer className="flex h-12 shrink-0 items-center justify-end gap-2 border-t px-3 text-sm text-muted-foreground">
                      <span className="tabular-nums">
                        {offset + 1}–{offset + page.data.rows.length} of {page.data.total}
                      </span>
                      <Button size="icon-sm" variant="ghost" aria-label="Previous rows" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - page.data.limit))}>
                        <ChevronLeftIcon />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label="Next rows" disabled={offset + page.data.limit >= page.data.total} onClick={() => setOffset(offset + page.data.limit)}>
                        <ChevronRightIcon />
                      </Button>
                    </footer>
                  )}
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

"use client";

// A file the AI employee made, opened in a panel beside the chat or the Files list: shown as itself where the browser can
// (pictures, PDFs, audio, video, web pages), as text where only its words can be (Word, Excel, PowerPoint,
// CSV), with Download and a share link. Web pages run in a sandboxed frame from our storage's address, so
// their scripts can't reach the app.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MadeFile } from "@emplio/shared";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ChevronLeftIcon,
  ExternalLinkIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileDownIcon,
  FileVideoIcon,
  FilterIcon,
  LinkIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import { MessageResponse } from "@/components/ai-elements/message";
import { fileHref } from "@/components/chat/attachments";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SidePanel } from "@/components/chat/browser-panel";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { inApp, saveFile } from "@/lib/save-file";
import { copyText } from "@/lib/utils";

// what a chat message carries about a file (older messages have no id: no text preview or sharing)
export type Shown = { id?: string; url: string; name: string; mediaType: string; conversationId?: string };

export const madeQueryKey = ["made"];

const downloadHref = (f: Shown) => `${fileHref(f.url)}?download=${encodeURIComponent(f.name)}`;
// the server answers with the file as a download, so the page stays. The iPhone app can't download: there the
// bytes (?raw, storage won't hand them to the page) go to the share sheet (save-file.ts).
export function download(f: Shown) {
  if (!inApp()) return void (window.location.href = downloadHref(f));
  fetch(`${fileHref(f.url)}?raw`, { credentials: "include" })
    .then(async (res) => {
      if (!res.ok) throw new Error(`Couldn't download ${f.name}.`);
      await saveFile(new Blob([await res.blob()], { type: f.mediaType }), f.name);
    })
    .catch((error: Error) => toast.error(error.message));
}

const ext = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";
const SHEET = ["xlsx", "xlsm", "xls", "ods", "csv", "tsv"];
const OFFICE = ["docx", "pptx", "odt", "odp", "doc", "ppt"];
const TEXT = ["txt", "json", "xml", "yaml", "yml", "log"];

type Kind = "image" | "pdf" | "audio" | "video" | "html" | "markdown" | "sheet" | "text" | "office" | "other";
export function kindOf(f: Pick<Shown, "name" | "mediaType">): Kind {
  const t = f.mediaType;
  const e = ext(f.name);
  if (t.startsWith("image/")) return "image";
  if (t === "application/pdf") return "pdf";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("video/")) return "video";
  if (t === "text/html" || e === "html" || e === "htm") return "html";
  if (e === "md") return "markdown";
  if (SHEET.includes(e)) return "sheet";
  if (OFFICE.includes(e)) return "office";
  if (TEXT.includes(e) || t.startsWith("text/")) return "text";
  return "other";
}

export function FileTypeIcon({ file, className }: { file: Pick<Shown, "name" | "mediaType">; className?: string }) {
  const k = kindOf(file);
  const e = ext(file.name);
  const Icon =
    k === "image" ? FileImageIcon
    : k === "audio" ? FileAudioIcon
    : k === "video" ? FileVideoIcon
    : k === "html" || k === "text" ? FileCodeIcon
    : k === "sheet" ? FileSpreadsheetIcon
    : k === "pdf" || k === "markdown" || k === "office" ? FileTextIcon
    : e === "zip" ? FileArchiveIcon
    : FileIcon;
  return <Icon className={className} />;
}

// Excel, OpenDocument and CSV sheets, read in the browser (SheetJS): one tab per sheet, cells as text the way
// Excel shows them. The bytes come through our server (?raw), as storage won't hand them to this page.
const MAX_ROWS = 2000;
const column = (i: number): string => (i < 26 ? "" : column(Math.floor(i / 26) - 1)) + String.fromCharCode(65 + (i % 26));

// Sorting a column: amounts as numbers, dates (with a year) as dates, the rest as text with numbers in order
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const sortKey = (v: string) => {
  const n = Number(v.replace(/[,₹$€£\s]/g, ""));
  if (v.trim() && !Number.isNaN(n)) return n;
  const d = /\b\d{4}\b/.test(v) ? Date.parse(v) : NaN;
  return Number.isNaN(d) ? v : d;
};
export function compareCells(a: string, b: string) {
  if (!a.trim() || !b.trim()) return !a.trim() ? (!b.trim() ? 0 : 1) : -1; // blanks last
  const [x, y] = [sortKey(a), sortKey(b)];
  return typeof x === "number" && typeof y === "number" ? x - y : collator.compare(a, b);
}

// A column's filter, as in Excel: values ticked off in its list, and/or one condition
const OPS = {
  contains: "Contains",
  "!contains": "Doesn't contain",
  "=": "Equals",
  "!=": "Doesn't equal",
  starts: "Begins with",
  ">": "Greater than",
  ">=": "Greater than or equal to",
  "<": "Less than",
  "<=": "Less than or equal to",
} as const;
type Op = keyof typeof OPS;
type ColFilter = { hidden: string[]; op: Op; value: string };
const NO_FILTER: ColFilter = { hidden: [], op: "contains", value: "" };
const active = (f?: ColFilter) => !!f && (f.hidden.length > 0 || !!f.value.trim());

export function passes(cell: string, f?: ColFilter) {
  if (!f) return true;
  if (f.hidden.includes(cell)) return false;
  const want = f.value.trim();
  if (!want) return true;
  const [a, b] = [cell.toLowerCase(), want.toLowerCase()];
  switch (f.op) {
    case "contains": return a.includes(b);
    case "!contains": return !a.includes(b);
    case "=": return compareCells(cell, want) === 0 || a === b;
    case "!=": return !(compareCells(cell, want) === 0 || a === b);
    case "starts": return a.startsWith(b);
    default: {
      if (!cell.trim()) return false;
      const c = compareCells(cell, want);
      return f.op === ">" ? c > 0 : f.op === ">=" ? c >= 0 : f.op === "<" ? c < 0 : c <= 0;
    }
  }
}

function FilterMenu({
  name,
  values,
  filter = NO_FILTER,
  sorted,
  onFilter,
  onSort,
}: {
  name: string;
  values: string[];
  filter?: ColFilter;
  sorted?: "asc" | "desc";
  onFilter: (f: ColFilter | null) => void;
  onSort: (desc: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const shown = values.filter((v) => (v || "(Blanks)").toLowerCase().includes(search.trim().toLowerCase()));
  const hidden = new Set(filter.hidden);
  const set = (f: Partial<ColFilter>) => onFilter({ ...filter, ...f });
  const tick = (v: string) => set({ hidden: hidden.has(v) ? filter.hidden.filter((h) => h !== v) : [...filter.hidden, v] });
  const all = shown.every((v) => !hidden.has(v));
  const item = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted";
  return (
    <div className="grid gap-2 text-xs">
      <div className="truncate px-2 pt-1 font-medium">{name}</div>
      <div className="grid">
        <button type="button" className={item} onClick={() => onSort(false)}>
          <ArrowUpIcon className="size-3.5" /> Sort smallest to largest {sorted === "asc" && <CheckIcon className="ml-auto size-3.5" />}
        </button>
        <button type="button" className={item} onClick={() => onSort(true)}>
          <ArrowDownIcon className="size-3.5" /> Sort largest to smallest {sorted === "desc" && <CheckIcon className="ml-auto size-3.5" />}
        </button>
      </div>
      <div className="grid gap-1.5 border-t pt-2">
        <Select items={OPS} value={filter.op} onValueChange={(v) => v && set({ op: v as Op })}>
          <SelectTrigger size="sm" className="w-full" aria-label="Condition">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(OPS).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input className="h-8" value={filter.value} onChange={(e) => set({ value: e.target.value })} placeholder="Value" />
      </div>
      <div className="grid gap-1.5 border-t pt-2">
        <Input className="h-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search values" />
        <div className="max-h-56 overflow-y-auto rounded-md border p-1">
          <label className={item}>
            <Checkbox
              checked={all}
              onCheckedChange={() => set({ hidden: all ? [...new Set([...filter.hidden, ...shown])] : filter.hidden.filter((h) => !shown.includes(h)) })}
            />
            (Select all)
          </label>
          {shown.map((v) => (
            <label key={v} className={item}>
              <Checkbox checked={!hidden.has(v)} onCheckedChange={() => tick(v)} />
              <span className="truncate">{v || "(Blanks)"}</span>
            </label>
          ))}
        </div>
      </div>
      <Button size="sm" variant="ghost" disabled={!active(filter)} onClick={() => onFilter(null)}>
        Clear filter
      </Button>
    </div>
  );
}

// Dragging a column's or row's edge to resize it, as in Excel (double-click fits a column, puts a row back)
function resize(e: React.PointerEvent, from: number, axis: "x" | "y", set: (size: number) => void) {
  e.preventDefault();
  e.stopPropagation();
  const start = axis === "x" ? e.clientX : e.clientY;
  const move = (m: PointerEvent) => set(Math.max(axis === "x" ? 40 : 24, from + (axis === "x" ? m.clientX : m.clientY) - start));
  const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function SheetView({ file }: { file: Shown }) {
  const book = useQuery({
    queryKey: [...madeQueryKey, file.url, "sheets"],
    queryFn: async () => {
      const res = await fetch(`${fileHref(file.url)}?raw`, { credentials: "include" });
      if (!res.ok) throw new Error("Couldn't open this file");
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await res.arrayBuffer(), { type: "array", ...(ext(file.name) === "tsv" && { FS: "\t" }) });
      return wb.SheetNames.map((name) => ({ name, rows: XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name]!, { header: 1, raw: false, defval: "" }) }));
    },
    staleTime: Infinity,
  });
  const [tab, setTab] = useState(0);
  // the first row is the headings (as in Excel's filter): it stays on top; the rest sort and filter by column
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);
  const [filters, setFilters] = useState<Record<number, ColFilter>>({});
  // selected cells, by position on screen (row in what's shown, column), as in Excel: click, drag or shift for a
  // range, a column letter for the whole column, arrows to move, Cmd+C copies it as tab-separated text that
  // pastes into Excel or Sheets
  type At = { r: number; c: number };
  const [sel, setSel] = useState<{ from: At; to: At } | null>(null);
  const dragging = useRef(false);
  // sizes someone dragged to: columns by index, rows by their number in the sheet
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [heights, setHeights] = useState<Record<number, number>>({});
  const sized = <T,>(m: Record<number, T>, k: number, v: T | null) => {
    const { [k]: _, ...rest } = m;
    return v === null ? rest : { ...rest, [k]: v };
  };
  const showTab = (i: number) => (setTab(i), setSort(null), setFilters({}), setSel(null));
  if (book.isPending) return <Spinner className="mx-auto mt-10 size-5" />;
  if (book.error || !book.data.length) return <NoPreview file={file} />;
  const sheet = book.data[Math.min(tab, book.data.length - 1)]!;
  const all = sheet.rows.slice(0, MAX_ROWS).map((r, i) => ({ r, n: i + 1 }));
  const width = Math.max(1, ...all.map(({ r }) => r.length));
  const cell = (r: string[], j: number) => String(r[j] ?? "");
  const filtered = Object.keys(filters).map(Number);
  // rows passing every column's filter but one's: what that column's list of values offers
  const passing = (except?: number) => all.slice(1).filter(({ r }) => filtered.every((j) => j === except || passes(cell(r, j), filters[j])));
  const body = passing();
  if (sort) body.sort((a, b) => compareCells(cell(a.r, sort.col), cell(b.r, sort.col)) * (sort.desc ? -1 : 1));
  const rows = all.length ? [all[0]!, ...body] : [];
  // double-clicking a column's edge fits it to the longest value shown, as in Excel
  const fit = (j: number) => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    const font = (ri: number) => {
      const s = getComputedStyle(document.getElementById(`cell-${ri}-${j}`)!);
      return `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    };
    const fonts = rows.length > 1 ? [font(0), font(1)] : [font(0)]; // the headings are bold
    let max = 0;
    rows.forEach(({ r }, ri) => {
      ctx.font = fonts[Math.min(ri, fonts.length - 1)]!;
      for (const line of cell(r, j).split("\n")) max = Math.max(max, ctx.measureText(line).width);
    });
    // ponytail: capped at 1000px so one long paragraph doesn't make a column wider than the screen
    setWidths((m) => sized(m, j, Math.min(1000, Math.max(80, Math.ceil(max) + 18)))); // + padding and border
  };
  const setFilter = (j: number, f: ColFilter | null) => {
    setSel(null);
    setFilters(({ [j]: _, ...rest }) => (f && active(f) ? { ...rest, [j]: f } : rest));
  };
  const box = sel && {
    top: Math.min(sel.from.r, sel.to.r),
    bottom: Math.max(sel.from.r, sel.to.r),
    left: Math.min(sel.from.c, sel.to.c),
    right: Math.max(sel.from.c, sel.to.c),
  };
  const picked = box ? rows.slice(box.top, box.bottom + 1).map(({ r }) => Array.from({ length: box.right - box.left + 1 }, (_, k) => cell(r, box.left + k))) : [];
  const numbers = picked.flat().map(sortKey).filter((v): v is number => typeof v === "number" && v < 1e11); // not dates
  const keys = (e: React.KeyboardEvent) => {
    // keys from the filter menus (in the page, outside the grid) aren't the grid's
    if (!e.currentTarget.contains(e.target as Node)) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "a") return e.preventDefault(), setSel({ from: { r: 0, c: 0 }, to: { r: rows.length - 1, c: width - 1 } });
    if (!sel) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "c") return e.preventDefault(), void copyText(picked.map((r) => r.join("\t")).join("\n")).catch(() => {});
    if (e.key === "Escape") return setSel(null);
    const [dr, dc] = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key] ?? [];
    if (dr === undefined || dc === undefined) return;
    e.preventDefault();
    const to = { r: Math.min(rows.length - 1, Math.max(0, sel.to.r + dr)), c: Math.min(width - 1, Math.max(0, sel.to.c + dc)) };
    setSel(e.shiftKey ? { from: sel.from, to } : { from: to, to });
    document.getElementById(`cell-${to.r}-${to.c}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div
        tabIndex={0}
        onKeyDown={keys}
        onMouseUp={() => (dragging.current = false)}
        onMouseLeave={() => (dragging.current = false)}
        className="min-h-0 flex-1 overflow-auto rounded-md border bg-background outline-none"
      >
        <table className="border-separate border-spacing-0 text-xs">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th className="sticky left-0 z-10 w-10 border-r border-b bg-muted" />
              {Array.from({ length: width }, (_, i) => {
                const on = active(filters[i]);
                return (
                  <th
                    key={i}
                    style={widths[i] ? { width: widths[i], minWidth: widths[i], maxWidth: widths[i] } : undefined}
                    className="relative min-w-20 border-r border-b p-0 font-normal text-muted-foreground"
                  >
                    <div className="flex items-center">
                      <button
                        type="button"
                        title="Select column"
                        onClick={(e) =>
                          setSel((s) => ({ from: e.shiftKey && s ? s.from : { r: 0, c: i }, to: { r: rows.length - 1, c: i } }))
                        }
                        className={`flex flex-1 items-center justify-center gap-1 py-1 pl-6 hover:text-foreground ${
                          box && i >= box.left && i <= box.right && box.top === 0 && box.bottom === rows.length - 1 ? "text-foreground" : ""
                        }`}
                      >
                        {column(i)}
                        {sort?.col === i && (sort.desc ? <ArrowDownIcon className="size-3" /> : <ArrowUpIcon className="size-3" />)}
                      </button>
                      <Popover>
                        <PopoverTrigger
                          title="Sort and filter"
                          className={`mr-1 grid size-5 place-items-center rounded hover:bg-background hover:text-foreground ${on ? "bg-primary/20 text-primary" : ""}`}
                        >
                          <FilterIcon className="size-3" />
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-64 p-2">
                              <FilterMenu
                                name={cell(all[0]?.r ?? [], i) || `Column ${column(i)}`}
                                values={[...new Set(passing(i).map(({ r }) => cell(r, i)))].sort(compareCells)}
                                filter={filters[i]}
                                sorted={sort?.col === i ? (sort.desc ? "desc" : "asc") : undefined}
                                onFilter={(f) => setFilter(i, f)}
                                onSort={(desc) => (setSel(null), setSort((s) => (s?.col === i && s.desc === desc ? null : { col: i, desc })))}
                              />
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div
                      title="Drag to resize; double-click to fit"
                      onPointerDown={(e) => resize(e, e.currentTarget.parentElement!.getBoundingClientRect().width, "x", (w) => setWidths((m) => sized(m, i, w)))}
                      onDoubleClick={() => fit(i)}
                      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize hover:bg-primary/40"
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ r, n }, ri) => (
              <tr key={n} className="select-none" style={heights[n] ? { height: heights[n] } : undefined}>
                <td
                  title="Select row"
                  onMouseDown={(e) => {
                    dragging.current = false;
                    setSel((s) => ({ from: { r: e.shiftKey && s ? s.from.r : ri, c: 0 }, to: { r: ri, c: width - 1 } }));
                  }}
                  className={`sticky left-0 cursor-pointer border-r border-b px-2 py-1 text-right align-top hover:text-foreground ${
                    box && ri >= box.top && ri <= box.bottom && box.left === 0 && box.right === width - 1
                      ? "bg-[color-mix(in_oklab,var(--primary)_25%,var(--muted))] text-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {n}
                  <div
                    title="Drag to resize; double-click to reset"
                    onPointerDown={(e) => resize(e, e.currentTarget.parentElement!.getBoundingClientRect().height, "y", (h) => setHeights((m) => sized(m, n, h)))}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={() => setHeights((m) => sized(m, n, null))}
                    className="absolute inset-x-0 -bottom-1 z-10 h-2 cursor-row-resize hover:bg-primary/40"
                  />
                </td>
                {Array.from({ length: width }, (_, j) => (
                  <td
                    key={j}
                    id={`cell-${ri}-${j}`}
                    onMouseDown={(e) => {
                      dragging.current = true;
                      const at = { r: ri, c: j };
                      setSel((s) => (e.shiftKey && s ? { from: s.from, to: at } : { from: at, to: at }));
                    }}
                    onMouseEnter={() => dragging.current && setSel((s) => s && { from: s.from, to: { r: ri, c: j } })}
                    style={widths[j] ? { width: widths[j], minWidth: widths[j], maxWidth: widths[j] } : undefined}
                    className={`max-w-80 border-r border-b px-2 py-1 ${heights[n] ? "align-top" : "truncate whitespace-nowrap"} ${ri === 0 ? "font-semibold" : ""} ${
                      box && ri >= box.top && ri <= box.bottom && j >= box.left && j <= box.right ? "bg-primary/15" : ""
                    } ${sel?.to.r === ri && sel.to.c === j ? "outline-2 -outline-offset-2 outline-primary" : ""}`}
                    title={r[j] || undefined}
                  >
                    {heights[n] ? (
                      // a taller row wraps its text, cut off at the row's height
                      <div className="overflow-hidden break-words whitespace-pre-wrap" style={{ maxHeight: heights[n] - 9 }}>
                        {r[j]}
                      </div>
                    ) : (
                      r[j]
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(book.data.length > 1 || sheet.rows.length > MAX_ROWS || filtered.length > 0 || picked.flat().length > 1) && (
        <div className="flex shrink-0 items-center gap-3 overflow-x-auto">
          {book.data.length > 1 && (
            <div className="flex items-center gap-1">
              {book.data.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => showTab(i)}
                  className={`shrink-0 rounded-md px-2.5 py-1 text-xs ${s === sheet ? "bg-background font-medium shadow-xs ring-1 ring-border" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
          <span className="ml-auto" />
          {picked.flat().length > 1 && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {picked.flat().filter((v) => v.trim()).length} cells
              {numbers.length > 0 && ` · Sum ${numbers.reduce((a, b) => a + b, 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
            </span>
          )}
          {filtered.length > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {body.length} of {all.length - 1} rows ·{" "}
              <button type="button" className="underline underline-offset-2" onClick={() => (setSel(null), setFilters({}))}>
                Clear filters
              </button>
            </span>
          )}
          {sheet.rows.length > MAX_ROWS && (
            <span className="shrink-0 text-xs text-muted-foreground">
              First {MAX_ROWS.toLocaleString()} of {sheet.rows.length.toLocaleString()} rows; download for the rest
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const finger = () => matchMedia("(pointer: coarse)").matches;

// the browser's own viewer opens a narrow frame with its page list down the side: hide it, fit the page to the width.
// Phones ignore that (an iPhone shows the page at full size, Android shows nothing), so there the pages are drawn here.
const PdfFrame = ({ href, title }: { href: string; title: string }) =>
  finger() ? <PdfPages href={href} title={title} /> : <iframe src={`${href}#navpanes=0&view=FitH`} title={title} className="size-full min-h-[70vh] rounded-md border bg-white" />;

function PdfPages({ href, title }: { href: string; title: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let left = false;
    let opening: PDFDocumentLoadingTask | undefined;
    (async () => {
      // the legacy build runs on older phones; loaded only here, as it's big
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
      const res = await fetch(`${href}?raw`, { credentials: "include" });
      if (!res.ok) throw new Error("not found");
      opening = pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()) });
      const loaded = await opening.promise;
      if (left) return void opening.destroy();
      setDoc(loaded);
    })().catch(() => !left && setFailed(true));
    return () => {
      left = true;
      void opening?.destroy();
    };
  }, [href]);
  if (failed)
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">
        This PDF can&apos;t be shown here.{" "}
        <a href={href} target="_blank" rel="noreferrer" className="underline">
          Open it in a new tab
        </a>
      </p>
    );
  if (!doc) return <Spinner className="mx-auto mt-10 size-5" />;
  return (
    <div className="grid gap-2" role="document" aria-label={title}>
      {Array.from({ length: doc.numPages }, (_, i) => (
        <PdfPage key={i} doc={doc} n={i + 1} />
      ))}
    </div>
  );
}

// One page, as wide as the panel, drawn only while near the screen: a phone runs out of memory on a long PDF's worth of pictures.
function PdfPage({ doc, n }: { doc: PDFDocumentProxy; n: number }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = box.current!;
    const c = canvas.current!;
    let near = false;
    let task: RenderTask | undefined;
    const draw = async () => {
      const page = await doc.getPage(n);
      const flat = page.getViewport({ scale: 1 });
      el.style.aspectRatio = `${flat.width} / ${flat.height}`;
      if (!near) return;
      const viewport = page.getViewport({ scale: (el.clientWidth * devicePixelRatio) / flat.width });
      c.width = viewport.width;
      c.height = viewport.height;
      task?.cancel();
      task = page.render({ canvas: c, viewport });
      await task.promise;
    };
    const watch = new IntersectionObserver(
      ([entry]) => {
        near = entry!.isIntersecting;
        if (near) void draw().catch(() => {});
        else {
          task?.cancel();
          c.width = c.height = 0;
        }
      },
      { root: el.closest(".overflow-auto"), rootMargin: "100%" },
    );
    watch.observe(el);
    return () => {
      watch.disconnect();
      task?.cancel();
    };
  }, [doc, n]);
  return (
    <div ref={box} className="relative w-full rounded-sm bg-white shadow-sm" style={{ aspectRatio: "1 / 1.414" }}>
      <canvas ref={canvas} className="absolute inset-0 size-full rounded-sm" />
    </div>
  );
}

// A web page on a phone: one wider than the screen shrinks to fit, as it does when opened in its own tab. It runs in the
// frame as before, with this script at its end; no access to the app, so it can only change its own page.
const FIT_PAGE = `<script>(function(){var d=document.documentElement,s=d.style;s.webkitTextSizeAdjust="100%";function f(){s.transform=s.width="";var w=d.scrollWidth,v=innerWidth;if(w>v+1){s.width=w+"px";s.transformOrigin="0 0";s.transform="scale("+v/w+")"}}addEventListener("load",f);addEventListener("resize",f)})()</script>`;

function HtmlFrame({ href, title }: { href: string; title: string }) {
  const frame = "size-full min-h-[70vh] rounded-md border bg-white";
  const sandbox = "allow-scripts allow-forms allow-popups allow-modals";
  const onPhone = finger();
  const page = useQuery({
    queryKey: ["html-page", href],
    queryFn: async () => {
      const res = await fetch(`${href}?raw`, { credentials: "include" });
      if (!res.ok) throw new Error("not found");
      return res.text();
    },
    enabled: onPhone,
  });
  if (!onPhone || page.isError) return <iframe src={href} title={title} sandbox={sandbox} className={frame} />;
  if (page.isPending) return <Spinner className="mx-auto mt-10 size-5" />;
  return <iframe srcDoc={page.data + FIT_PAGE} title={title} sandbox={sandbox} className={frame} />;
}

function Preview({ file }: { file: Shown }) {
  const kind = kindOf(file);
  const href = fileHref(file.url);
  const words = kind === "markdown" || kind === "text" || kind === "office";
  // a file's words (and a Word or PowerPoint file's PDF copy) come from the server, kept when it was made
  const made = useQuery({
    queryKey: [...madeQueryKey, file.id, "text"],
    queryFn: () => api<MadeFile & { text: string }>(`/made/${file.id}`),
    enabled: words && !!file.id,
  });
  const text = { isPending: made.isPending, data: made.data?.text };

  if (kind === "image") return <img src={href} alt={file.name} className="mx-auto max-h-full max-w-full object-contain" />;
  if (kind === "pdf") return <PdfFrame href={href} title={file.name} />;
  if (kind === "audio") return <audio src={href} controls className="w-full" />;
  if (kind === "video") return <video src={href} controls className="max-h-full w-full rounded-md bg-black" />;
  if (kind === "sheet") return <SheetView file={file} />;
  if (kind === "html") return <HtmlFrame href={href} title={file.name} />;
  if (words && file.id) {
    if (text.isPending) return <Spinner className="mx-auto mt-10 size-5" />;
    // shown as it looks; Download and Share still give the Word or PowerPoint file itself
    if (made.data?.previewUrl) return <PdfFrame href={fileHref(made.data.previewUrl)} title={file.name} />;
    if (!text.data?.trim()) return <NoPreview file={file} />;
    // a page to read, with margins, not words against the screen's edge
    if (kind === "markdown")
      return (
        <article className="mx-auto max-w-3xl rounded-lg border bg-background px-4 py-5 sm:px-8 sm:py-7">
          <MessageResponse className="text-sm">{text.data}</MessageResponse>
        </article>
      );
    return (
      <div className="grid gap-2">
        {kind === "office" && <p className="text-xs text-muted-foreground">Only the words are shown here. Download it to see it as it looks.</p>}
        <pre className="overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">{text.data}</pre>
      </div>
    );
  }
  return <NoPreview file={file} />;
}

function NoPreview({ file }: { file: Shown }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-muted-foreground">
      <FileTypeIcon file={file} className="size-10 opacity-50" />
      This file can&apos;t be shown here.
      <Button size="sm" onClick={() => download(file)}>
        <DownloadIcon /> Download
      </Button>
    </div>
  );
}

// In the panel's top bar: not shared, one click makes a link anyone can open and copies it; shared, the
// button is lit and opens Copy link / Stop sharing.
function Share({ id }: { id: string }) {
  const qc = useQueryClient();
  const made = useQuery({ queryKey: [...madeQueryKey, id], queryFn: () => api<MadeFile>(`/made/${id}`) });
  const [copied, setCopied] = useState(false);
  const copy = async (link: string) => {
    await copyText(link).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const toggle = useMutation({
    mutationFn: (on: boolean) => api<{ url: string | null }>(`/made/${id}/share`, on ? {} : undefined, on ? "POST" : "DELETE"),
    onSuccess: (r) => {
      if (r.url) void copy(r.url);
      return qc.invalidateQueries({ queryKey: madeQueryKey });
    },
  });
  const link = made.data?.shareUrl;
  if (made.isPending) return null;
  if (!link)
    return (
      <Button size="sm" variant="ghost" className="h-8 gap-1.5" disabled={toggle.isPending} onClick={() => toggle.mutate(true)} title="Make a link anyone can open, no sign-in needed">
        <LinkIcon /> Share
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="sm" variant="secondary" className="h-8 gap-1.5" />}>
        {copied ? <CheckIcon /> : <UsersIcon />} {copied ? "Link copied" : "Shared"}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Anyone with the link can open it, without signing in.</p>
        <DropdownMenuItem onClick={() => void copy(link)}>
          <CopyIcon /> Copy link
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={() => toggle.mutate(false)}>
          <LinkIcon /> Stop sharing
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The words as a PDF: drawn in a hidden frame and handed to the browser's own Save as PDF (print), so nothing to
// install and it looks like the preview. ponytail: the print dialog, not a straight download; a server-side
// converter if people want one click
export async function savePdf(file: Shown) {
  const res = await fetch(`${fileHref(file.url)}?raw`, { credentials: "include" });
  const text = res.ok ? await res.text() : "";
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  // the PDF's suggested name is the title: the frame's in some browsers, the page's in Chrome, so both for now
  const title = file.name.replace(/\.[^.]+$/, "");
  const pageTitle = document.title;
  doc.title = document.title = title;
  const style = doc.createElement("style");
  style.textContent = `body{font:14px/1.6 system-ui,sans-serif;color:#111;margin:0;padding:0 4px}
    h1,h2,h3{line-height:1.3;margin:1.2em 0 .4em}h1{font-size:22px}h2{font-size:18px}h3{font-size:15px}
    table{border-collapse:collapse;margin:.8em 0}th,td{border:1px solid #ccc;padding:4px 8px;text-align:left}
    pre{white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace}code{font-family:ui-monospace,monospace}
    blockquote{border-left:3px solid #ccc;margin:.8em 0;padding-left:12px;color:#444}
    @page{margin:18mm}`;
  doc.head.appendChild(style);
  const root = createRoot(doc.body.appendChild(doc.createElement("div")));
  flushSync(() => root.render(ext(file.name) === "md" ? <Streamdown>{text}</Streamdown> : <pre>{text}</pre>));
  const done = () => ((document.title = pageTitle), root.unmount(), frame.remove());
  frame.contentWindow!.addEventListener("afterprint", done, { once: true });
  frame.contentWindow!.print();
}

// Download: the file itself; a .md or .txt one can also be saved as a PDF (not in the iPhone app: no print there).
function DownloadButton({ file, label }: { file: Shown; label: string }) {
  const e = ext(file.name);
  if (e !== "md" && e !== "txt")
    return (
      <Button size="icon-sm" variant="ghost" title="Download" aria-label={label} onClick={() => download(file)}>
        <DownloadIcon />
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" title="Download" aria-label={label} />}>
        <DownloadIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-max">
        <DropdownMenuItem onClick={() => download(file)}>
          <DownloadIcon /> Download as .{e}
        </DropdownMenuItem>
        {/* drawn only when open, so the page and the server agree on the button */}
        {!inApp() && (
          <DropdownMenuItem onClick={() => void savePdf(file)}>
            <FileDownIcon /> Download as PDF
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Which file is open in the side panel: set by the cards in the chat (MadeCards) and the Files page, shown
// by whoever renders FilePanel beside them.
const OpenFile = createContext<((f: Shown) => void) | null>(null);
export const OpenFileProvider = OpenFile.Provider;
export const useOpenFile = () => useContext(OpenFile);

// Beside the chat (or the Files list) like the live browser, full screen on phones.
export function FilePanel({ file: given, onClose }: { file: Shown | null; onClose: () => void }) {
  // one from an older chat has no record yet: made on opening, so it can be shared too (backend made.ts)
  const adopted = useQuery({
    queryKey: [...madeQueryKey, "adopt", given?.url],
    queryFn: () => api<MadeFile>("/made/adopt", { url: given!.url, name: given!.name, mediaType: given!.mediaType, conversationId: given!.conversationId }),
    enabled: !!given && !given.id && !!given.conversationId,
    staleTime: Infinity,
  });
  const file = given && !given.id && adopted.data ? { ...given, id: adopted.data.id } : given;
  if (!file) return null;
  return (
    <SidePanel label="File" widthKey="file-panel-width">
      {(dragging) => (
        <>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 max-lg:gap-1 max-lg:pl-1.5">
            {/* on a phone the file covers the page: back first, where a thumb expects it */}
            <Button size="icon" variant="ghost" onClick={onClose} className="size-10 shrink-0 lg:hidden" aria-label="Back">
              <ChevronLeftIcon className="size-5" />
            </Button>
            <FileTypeIcon file={file} className="size-4 shrink-0 text-muted-foreground max-lg:hidden" />
            <span className="min-w-0 truncate text-sm font-medium" title={file.name}>
              {file.name}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {file.id && <Share key={file.id} id={file.id} />}
              <DownloadButton file={file} label="Download" />
              {/* the iPhone app would hand it to Safari, which isn't signed in */}
              {!inApp() && (
                <Button size="icon-sm" variant="ghost" title="Open in new tab" aria-label="Open in new tab" nativeButton={false} render={<a href={fileHref(file.url)} target="_blank" rel="noreferrer" />}>
                  <ExternalLinkIcon />
                </Button>
              )}
              <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close" className="max-lg:hidden">
                <XIcon />
              </Button>
            </div>
          </header>
          {/* the page, not a frame inside it, gets the pointer while the edge is dragged */}
          <div className={`min-h-0 flex-1 overflow-auto bg-muted/40 p-2 lg:p-3 ${dragging ? "pointer-events-none" : ""}`}>
            <Preview file={file} />
          </div>
        </>
      )}
    </SidePanel>
  );
}

// The files a reply made, under it: pictures as themselves, everything else as a card; a click opens it beside the chat.
export function MadeCards({ files }: { files: { id?: string; url: string; filename: string; mediaType?: string }[] }) {
  const open = useOpenFile();
  const shown = [...new Map(files.map((f) => [f.url, { id: f.id, url: f.url, name: f.filename, mediaType: f.mediaType ?? "application/octet-stream" }])).values()];
  return (
    <div className="flex flex-wrap gap-2">
        {shown.map((f) =>
          kindOf(f) === "image" ? (
            <button key={f.url} type="button" onClick={() => open?.(f)} className="overflow-hidden rounded-lg border hover:opacity-90" aria-label={`Open ${f.name}`}>
              <img src={fileHref(f.url)} alt={f.name} className="h-40 max-w-64 object-cover" />
            </button>
          ) : (
            <div key={f.url} className="flex w-72 max-w-full items-center gap-1 rounded-lg border bg-card pr-1 hover:bg-accent/50">
              <button type="button" onClick={() => open?.(f)} className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-2.5 text-left">
                <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                  <FileTypeIcon file={f} className="size-4.5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{f.name}</span>
                  <span className="block text-xs text-muted-foreground">{ext(f.name).toUpperCase() || "File"} · Open</span>
                </span>
              </button>
              <DownloadButton file={f} label={`Download ${f.name}`} />
            </div>
          ),
        )}
    </div>
  );
}

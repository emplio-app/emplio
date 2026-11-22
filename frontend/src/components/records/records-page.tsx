"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BizRecord, RecordInput } from "@emplio/shared";
import { ChevronRightIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ClientPicker } from "@/components/clients/client-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, processRunsQueryKey, recordsQueryKey, useClients, useMe, useProcessRuns, useRecordKinds, useRecords } from "@/lib/api";
import { cn } from "@/lib/utils";

const plural = (k: string) => (k.endsWith("s") ? k : k.endsWith("y") ? `${k.slice(0, -1)}ies` : `${k}s`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const label = (k: string) => cap(k.replace(/_/g, " "));

function useSave(id?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RecordInput) => (id ? api<BizRecord>(`/records/${id}`, body, "PATCH") : api<BizRecord>("/records", body)),
    onError: (e) => toast.error(e.message),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: recordsQueryKey }),
  });
}

export function RecordsPage() {
  const kinds = useRecordKinds();
  const [picked, setPicked] = useState<string | null>(null);
  const kind = picked ?? kinds.data?.[0]?.kind ?? null;
  const list = useRecords({ kind: kind ?? undefined });
  const [open, setOpen] = useState<string | null>(null);
  const current = list.data?.find((r) => r.id === open) ?? null;
  const fieldNames = [...new Set((list.data ?? []).flatMap((r) => Object.keys(r.fields)))].slice(0, 4);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <h1 className="px-2 font-sans text-sm font-medium tracking-normal">Records</h1>
        <div className="ml-auto">
          <AddRecord kind={kind} onAdded={(r) => setPicked(r.kind)} />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {kinds.isPending ? (
          <div className="mx-auto grid max-w-5xl gap-3 px-4 py-6 md:px-6">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : !kinds.data?.length ? (
          <div className="mx-auto grid max-w-md justify-items-center gap-3 px-6 py-24 text-center">
            <h2 className="text-lg font-semibold">No records yet</h2>
            <p className="text-sm text-muted-foreground">
              Records are the things you track that aren&rsquo;t clients: invoices, candidates, projects. Emplio adds them as work comes in, and a process can run for
              each one, like chasing an unpaid invoice.
            </p>
          </div>
        ) : (
          <div className="mx-auto grid max-w-5xl gap-4 px-4 py-6 md:px-6">
            <div className="flex gap-1 overflow-x-auto">
              {kinds.data.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  onClick={() => setPicked(k.kind)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60",
                    kind === k.kind && "bg-muted font-medium text-foreground",
                  )}
                >
                  {cap(plural(k.kind))}
                  <span className="text-xs tabular-nums text-muted-foreground">{k.n}</span>
                </button>
              ))}
            </div>
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">{kind ? cap(kind) : ""}</TableHead>
                    <TableHead>Client</TableHead>
                    {fieldNames.map((f) => (
                      <TableHead key={f}>{label(f)}</TableHead>
                    ))}
                    <TableHead>Status</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.isPending ? (
                    <TableRow>
                      <TableCell colSpan={fieldNames.length + 4}>
                        <Skeleton className="h-8 w-full" />
                      </TableCell>
                    </TableRow>
                  ) : (
                    (list.data ?? []).map((r) => (
                      <TableRow key={r.id} className="cursor-pointer" onClick={() => setOpen(r.id)}>
                        <TableCell className="pl-4 font-medium">{r.title}</TableCell>
                        <TableCell className="text-muted-foreground">{r.clientName ?? "—"}</TableCell>
                        {fieldNames.map((f) => (
                          <TableCell key={f} className="max-w-48 truncate text-muted-foreground">
                            {r.fields[f] ?? "—"}
                          </TableCell>
                        ))}
                        <TableCell>
                          <span className="inline-flex items-center gap-1.5">
                            <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{r.status}</span>
                            {r.active > 0 && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{r.active} going</span>}
                          </span>
                        </TableCell>
                        <TableCell>
                          <ChevronRightIcon className="size-4 text-muted-foreground" />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </div>
      <Sheet open={!!current} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full gap-0 sm:max-w-md">{current && <RecordDetails key={current.id} r={current} onRemoved={() => setOpen(null)} />}</SheetContent>
      </Sheet>
    </div>
  );
}

function AddRecord({ kind, onAdded }: { kind: string | null; onAdded: (r: BizRecord) => void }) {
  const [open, setOpen] = useState(false);
  const [k, setK] = useState(kind ?? "");
  const [title, setTitle] = useState("");
  const save = useSave();
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setK(kind ?? "");
      }}
    >
      <PopoverTrigger render={<Button size="sm" variant="outline" />}>
        <PlusIcon />
        Add
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <PopoverHeader>
          <PopoverTitle>Add a record</PopoverTitle>
        </PopoverHeader>
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(
              { kind: k, title },
              {
                onSuccess: (r) => {
                  setOpen(false);
                  setTitle("");
                  onAdded(r);
                },
              },
            );
          }}
        >
          <Input value={k} onChange={(e) => setK(e.target.value)} placeholder="Kind, e.g. invoice" aria-label="Kind" />
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title, e.g. INV-1042" aria-label="Title" />
          <Button type="submit" disabled={!k.trim() || !title.trim() || save.isPending}>
            Add
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function RecordDetails({ r, onRemoved }: { r: BizRecord; onRemoved: () => void }) {
  const { data: me } = useMe();
  const admin = me?.workspaces[0]?.role !== "member";
  const clients = useClients();
  const runs = useProcessRuns({ record: r.id, all: true });
  const save = useSave(r.id);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api(`/records/${r.id}`, undefined, "DELETE"),
    onSuccess: () => {
      onRemoved();
      void queryClient.invalidateQueries({ queryKey: processRunsQueryKey });
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: recordsQueryKey }),
  });
  const [newField, setNewField] = useState("");
  const blurSave = (key: keyof RecordInput | "field", value: string, field?: string) => {
    if (key === "field") {
      if ((r.fields[field!] ?? "") !== value) save.mutate({ fields: { [field!]: value } });
    } else if ((r[key as "title" | "status"] ?? "") !== value && value.trim()) save.mutate({ [key]: value });
  };
  return (
    <>
      <SheetHeader className="border-b">
        <SheetTitle>{r.title}</SheetTitle>
        <SheetDescription>{cap(r.kind)}</SheetDescription>
      </SheetHeader>
      <div className="grid min-h-0 flex-1 content-start gap-6 overflow-y-auto p-4">
        <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
          <Label htmlFor="rec-title" className="text-muted-foreground">
            Title
          </Label>
          <Input id="rec-title" defaultValue={r.title} onBlur={(e) => blurSave("title", e.target.value)} />
          <Label htmlFor="rec-status" className="text-muted-foreground">
            Status
          </Label>
          <Input id="rec-status" defaultValue={r.status} onBlur={(e) => blurSave("status", e.target.value)} />
          <Label className="text-muted-foreground">Client</Label>
          <ClientPicker
            items={[{ value: "", label: "No client" }, ...(clients.data ?? []).map((c) => ({ value: c.id, label: c.name }))]}
            value={r.clientId ?? ""}
            onChange={(v) => save.mutate({ clientId: v || null })}
            className="w-full"
          />
          {Object.entries(r.fields).map(([k, v]) => (
            <FieldRow key={k} name={k} value={v} onSave={(val) => blurSave("field", val, k)} onRemove={() => save.mutate({ fields: { [k]: "" } })} />
          ))}
          <Input value={newField} onChange={(e) => setNewField(e.target.value)} placeholder="New field" aria-label="New field name" className="h-8 text-xs" />
          <Input
            placeholder="Its value, then Enter"
            aria-label="New field value"
            className="h-8 text-xs"
            disabled={!newField.trim()}
            onKeyDown={(e) => {
              const v = e.currentTarget.value.trim();
              if (e.key === "Enter" && v && newField.trim()) {
                save.mutate({ fields: { [newField.trim()]: v } });
                setNewField("");
                e.currentTarget.value = "";
              }
            }}
          />
        </div>
        <section className="grid gap-2">
          <h2 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">Processes</h2>
          {runs.data?.length ? (
            <ul className="grid gap-1.5">
              {runs.data.map((run) => (
                <li key={run.id}>
                  <Link href={`/processes/${run.process}`} className="grid gap-1.5 rounded-lg border px-3 py-2.5 hover:bg-muted/50">
                    <span className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate font-medium">{run.processTitle}</span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {run.status === "active" ? `${run.step + 1}/${run.steps.length}` : run.status}
                      </span>
                    </span>
                    {run.status === "active" && <span className="truncate text-xs text-muted-foreground">{run.steps[run.step]?.name}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No process has run for it yet.</p>
          )}
        </section>
      </div>
      {admin && (
        <SheetFooter className="flex-row border-t">
          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
            <Trash2Icon />
            Delete
          </Button>
        </SheetFooter>
      )}
    </>
  );
}

function FieldRow({ name, value, onSave, onRemove }: { name: string; value: string; onSave: (v: string) => void; onRemove: () => void }) {
  return (
    <>
      <Label htmlFor={`f-${name}`} className="truncate text-muted-foreground">
        {label(name)}
      </Label>
      <div className="flex items-center gap-1">
        <Input id={`f-${name}`} defaultValue={value} onBlur={(e) => onSave(e.target.value)} />
        <Button variant="ghost" size="icon-sm" aria-label={`Remove ${label(name)}`} onClick={onRemove}>
          <XIcon />
        </Button>
      </div>
    </>
  );
}

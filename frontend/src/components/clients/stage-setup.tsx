"use client";

// The business's own stages (each one of prospect, active, past) and the details kept on every client, contact, project
// or service, for owners and admins (backend clients.ts /client-stages, fields.ts /fields/:kind). Emplio sets sensible
// ones up; this is where they're changed.
import { type ClientDetail, type ClientField, type ClientStage, FIELD_TYPES, type FieldKind, STAGE_CATEGORIES, type StageCategory } from "@emplio/shared";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, useClients, useFields, useSaveRecord, useStages } from "@/lib/api";
import { CATEGORY, QUIET } from "./shared";

const TYPE: Record<ClientField["type"], string> = { text: "Text", number: "Number", date: "Date", choice: "Choice" };

function Pick<T extends string>({ value, items, label, onChange, className }: { value: T; items: { value: T; label: string }[]; label: string; onChange: (v: T) => void; className?: string }) {
  return (
    <Select items={items} value={value} onValueChange={(v) => v && v !== value && onChange(v as T)}>
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

// text saved when the box is left (Enter too)
function Text({ value, label, onSave, placeholder, className }: { value: string; label: string; onSave: (v: string) => void; placeholder?: string; className?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <Input
      aria-label={label}
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => (v.trim() && v.trim() !== value ? onSave(v.trim()) : setV(value))}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className={className ?? QUIET}
    />
  );
}

const CATEGORIES = STAGE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY[c].label }));
const TYPES = FIELD_TYPES.map((t) => ({ value: t, label: TYPE[t] }));

export function StageSetup() {
  const stages = useStages().data ?? [];
  const clients = useClients().data ?? [];
  const [dialog, confirm] = useConfirm();
  const stage = useSaveRecord(({ id, ...body }: { id?: string; name?: string; category?: StageCategory }) => api<ClientStage[]>(id ? `/client-stages/${id}` : "/client-stages", body, id ? "PATCH" : "POST"));
  const dropStage = useSaveRecord(({ id, to }: { id: string; to?: string }) => api(`/client-stages/${id}${to ? `?to=${encodeURIComponent(to)}` : ""}`, undefined, "DELETE"));
  const [newStage, setNewStage] = useState({ name: "", category: "active" as StageCategory });

  const removeStage = (s: ClientStage) => {
    const n = clients.filter((c) => c.stage === s.name).length;
    // its clients go to the first other stage of the same kind, else the first other one
    const to = stages.find((x) => x.id !== s.id && x.category === s.category) ?? stages.find((x) => x.id !== s.id);
    confirm({
      title: `Remove ${s.name}?`,
      description: n ? `Its ${n} client${n === 1 ? " moves" : "s move"} to ${to?.name}.` : "No client is at this stage.",
      action: "Remove",
      onConfirm: () => dropStage.mutate({ id: s.id, to: n ? to?.name : undefined }),
    });
  };
  return (
    <div className="grid gap-6">
      {dialog}
      <section className="grid gap-2">
        <h3 className="text-sm font-medium">Stages</h3>
        <p className="text-xs text-pretty text-muted-foreground">
          Each is a prospect, active or past stage. Moving a client from a prospect stage to an active one is when Emplio starts their onboarding.
        </p>
        <ul className="grid gap-1">
          {stages.map((s) => (
            <li key={s.id} className="grid grid-cols-[minmax(0,1fr)_8rem_auto] items-center gap-1.5">
              <Text value={s.name} label="Stage name" onSave={(name) => stage.mutate({ id: s.id, name })} />
              <Pick value={s.category} items={CATEGORIES} label={`${s.name} is`} onChange={(category) => stage.mutate({ id: s.id, category })} className="w-full" />
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${s.name}`} disabled={stages.length < 2} onClick={() => removeStage(s)} className="text-muted-foreground">
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="grid grid-cols-[minmax(0,1fr)_8rem_auto] items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newStage.name.trim()) return;
            stage.mutate(newStage, { onSuccess: () => setNewStage({ ...newStage, name: "" }) });
          }}
        >
          <Input placeholder="New stage, e.g. Onboarding" aria-label="New stage" value={newStage.name} onChange={(e) => setNewStage({ ...newStage, name: e.target.value })} />
          <Pick value={newStage.category} items={CATEGORIES} label="New stage is" onChange={(category) => setNewStage({ ...newStage, category })} className="w-full" />
          <Button type="submit" variant="ghost" size="icon-sm" aria-label="Add stage" disabled={!newStage.name.trim()}>
            <PlusIcon />
          </Button>
        </form>
      </section>

      <section className="grid gap-2">
        <h3 className="text-sm font-medium">Details on every client</h3>
        <FieldSetup kind="client" records={clients} />
      </section>
    </div>
  );
}

const EXAMPLE: Record<FieldKind, string> = { client: "Tax number", contact: "Birthday", project: "PO number", service: "SAC code" };

// The details kept on every record of one kind; records: those there now, to say how many lose a value
export function FieldSetup({ kind, records }: { kind: FieldKind; records: { details: ClientDetail[] }[] }) {
  const fields = useFields(kind).data ?? [];
  const [dialog, confirm] = useConfirm();
  const field = useSaveRecord(({ id, ...body }: { id?: string; name?: string; type?: ClientField["type"]; options?: string[] }) => api<ClientField[]>(id ? `/fields/${kind}/${id}` : `/fields/${kind}`, body, id ? "PATCH" : "POST"));
  const dropField = useSaveRecord((id: string) => api(`/fields/${kind}/${id}`, undefined, "DELETE"));
  const [newField, setNewField] = useState({ name: "", type: "text" as ClientField["type"] });
  const removeField = (f: ClientField) => {
    const n = records.filter((c) => c.details.some((d) => d.key === f.key)).length;
    confirm({
      title: `Remove ${f.name}?`,
      description: n ? `It's filled in on ${n} ${kind}${n === 1 ? "" : "s"}; those values go too (they stay in each one's history).` : `No ${kind} has it filled in.`,
      action: "Remove",
      onConfirm: () => dropField.mutate(f.id),
    });
  };

  return (
    <div className="grid gap-2">
      {dialog}
      <p className="text-xs text-pretty text-muted-foreground">
        Anyone who can change one fills these in, and Emplio does as it learns them.{kind === "client" && " A process asking for one of the same name gets it filled in."}
      </p>
      <ul className="grid gap-1.5">
        {fields.map((f) => (
          <li key={f.id} className="grid gap-1">
            <div className="grid grid-cols-[minmax(0,1fr)_8rem_auto] items-center gap-1.5">
              <Text value={f.name} label="Detail name" onSave={(name) => field.mutate({ id: f.id, name })} />
              <Pick value={f.type} items={TYPES} label={`${f.name} is`} onChange={(type) => field.mutate({ id: f.id, type, ...(type === "choice" && !f.options.length && { options: ["Yes", "No"] }) })} className="w-full" />
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${f.name}`} onClick={() => removeField(f)} className="text-muted-foreground">
                <Trash2Icon />
              </Button>
            </div>
            {f.type === "choice" && (
              <Text
                value={f.options.join(", ")}
                label={`${f.name} choices`}
                placeholder="Choices, separated by commas"
                onSave={(v) => field.mutate({ id: f.id, options: v.split(",").map((o) => o.trim()).filter(Boolean) })}
                className={`${QUIET} text-xs text-muted-foreground`}
              />
            )}
          </li>
        ))}
      </ul>
      <form
        className="grid grid-cols-[minmax(0,1fr)_8rem_auto] items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newField.name.trim()) return;
          field.mutate({ ...newField, ...(newField.type === "choice" && { options: ["Yes", "No"] }) }, { onSuccess: () => setNewField({ ...newField, name: "" }) });
        }}
      >
        <Input placeholder={`New detail, e.g. ${EXAMPLE[kind]}`} aria-label="New detail" value={newField.name} onChange={(e) => setNewField({ ...newField, name: e.target.value })} />
        <Pick value={newField.type} items={TYPES} label="New detail is" onChange={(type) => setNewField({ ...newField, type })} className="w-full" />
        <Button type="submit" variant="ghost" size="icon-sm" aria-label="Add detail" disabled={!newField.name.trim()}>
          <PlusIcon />
        </Button>
      </form>
    </div>
  );
}

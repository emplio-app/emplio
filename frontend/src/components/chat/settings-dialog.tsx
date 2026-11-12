"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MODEL_PROVIDERS,
  MODEL_SETS,
  SETTING_FIELDS,
  SETTING_SECTIONS,
  type ModelOption,
  type Settings,
  type SettingsResponse,
  type SetupStatus,
} from "@emplio/shared";
import { BrainIcon, Building2Icon, CalendarClockIcon, ChevronRightIcon, MessagesSquareIcon, MonitorIcon, SunMoonIcon, UserIcon } from "lucide-react";
import { BusinessTab, YouTab } from "@/components/chat/settings-people";
import { useRouter } from "next/navigation";
import { SeePlans } from "@cloud/client";
import { SAY_TEXT } from "@/components/chat/attachments";
import { useDraft } from "@/components/chat/draft";
import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { setThemeChoice, themeChoice, type ThemeChoice } from "@/lib/theme";

const settingsQueryKey = ["settings"];
type Field = (typeof SETTING_FIELDS)[number];
type Value = Settings[keyof Settings];
const ICONS = { work: BrainIcon, memory: MessagesSquareIcon, computer: MonitorIcon, schedule: CalendarClockIcon };
// The tabs run down the side on wide screens and across the top on a phone: there the line under the open one
// sits on the row's bottom border (its p-2 and 1px border), not up the tab's right edge.
const TAB =
  "h-9 px-1.5 text-xs sm:h-11 sm:flex-none sm:gap-2.5 sm:px-3 sm:text-[0.95rem] [&_svg]:max-sm:hidden sm:[&_svg:not([class*='size-'])]:size-[18px] max-sm:after:inset-x-0! max-sm:after:top-auto! max-sm:after:-bottom-[9px]! max-sm:after:h-0.5! max-sm:after:w-auto!";

// what Quality shows once any model was picked by hand
const CUSTOM = "custom";

// a choice's options, plus the current value when it isn't one of them (a default set on the server)
const optionsOf = (f: Field & { type: "choice" }, value: Value) =>
  f.options.some((o) => o.value === value)
    ? f.options
    : [...f.options, { value: String(value), label: value === CUSTOM ? "Custom" : String(value) }];

const shown = (f: Field, v: Value, models: ModelOption[] = []) =>
  f.type === "toggle"
    ? v ? "On" : "Off"
    : f.type === "number"
      ? `${Number(v).toLocaleString()} ${f.unit}`
      : f.type === "key"
        ? v ? "Your key" : "Ours"
      : f.type === "model"
        ? v === "auto" ? "Auto" : (models.find((m) => m.id === v)?.name ?? String(v))
        : (optionsOf(f, v).find((o) => o.value === v)?.label ?? String(v));

const PROVIDER_ITEMS = [
  { value: "auto", label: "Auto (follows Quality)" },
  ...MODEL_PROVIDERS.map((p) => ({ value: p.key, label: p.label })),
  // any other OpenRouter model, typed in by name (the server checks it exists and can use tools)
  { value: "custom", label: "Custom model" },
];
const MODEL_FIELDS = SETTING_FIELDS.filter((f) => f.type === "model");

// Under Quality: which models were picked by hand (Quality doesn't change those), and the way to the pickers.
function QualityNote({
  picked,
  models,
  onCustomize,
}: {
  picked: { label: string; model: string }[];
  models?: ModelOption[];
  onCustomize: () => void;
}) {
  return (
    <p className="text-xs text-muted-foreground">
      {picked.length > 0 &&
        `Picked by hand: ${picked
          .map((p) => `${p.label} (${models?.find((m) => m.id === p.model)?.name ?? p.model})`)
          .join(", ")}. Choosing a Quality resets them. `}
      <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={onCustomize}>
        {picked.length ? "Change models" : "Pick models yourself"}
      </Button>
    </p>
  );
}

// the model a model setting left on Auto runs right now, for the Quality picked
const autoModel = (f: Field, set: Value) =>
  f.type === "model" ? (MODEL_SETS[set as keyof typeof MODEL_SETS] ?? MODEL_SETS.default)[f.key] : undefined;

const tokens = (n: number) => (n >= 1e6 ? `${n / 1e6}M` : `${Math.round(n / 1e3)}K`);

// How the AI employee behaves, for the whole business, each setting with its default beside it.
// Everyone can look; the owner and admins can change. Applies from the next message.
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: settingsQueryKey,
    queryFn: () => api<SettingsResponse>("/settings"),
    enabled: open,
  });
  const models = useQuery({
    queryKey: ["models"],
    queryFn: () => api<ModelOption[]>("/models"),
    enabled: open,
    staleTime: 60 * 60 * 1000,
  });
  // only what was edited and not saved yet; everything else shows as saved
  const [draft, setDraft] = useState<Partial<Record<string, Value>>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Business, You and Appearance save on their own: the Save bar is for the agent's settings only
  const [tab, setTab] = useState<string>(SETTING_SECTIONS[0].key);
  const agentTab = SETTING_SECTIONS.some((s) => s.key === tab);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<SettingsResponse>("/settings", body, "PUT"),
    onSuccess: (data) => {
      queryClient.setQueryData(settingsQueryKey, data);
      setDraft({});
    },
  });

  const data = settings.data;
  const changed = data
    ? SETTING_FIELDS.filter(
        (f) => f.key in draft && draft[f.key] !== data.values[f.key],
      )
    : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDraft({});
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex h-[min(90dvh,40rem)] flex-col gap-0 p-0 sm:max-w-4xl">
        <DialogHeader className="border-b p-4 sm:px-6">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            For everyone in the business. Changes apply from the next message.
            {data && !data.canEdit &&
              " Only the owner or an admin can change these."}
          </DialogDescription>
        </DialogHeader>

        {settings.isPending && (
          <p className="p-6 text-sm text-muted-foreground">Loading…</p>
        )}
        {settings.error && (
          <p className="p-6 text-sm text-destructive">
            {settings.error.message}
          </p>
        )}
        {data && (
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(String(v))}
            orientation="vertical"
            className="min-h-0 flex-1 flex-col gap-0 sm:flex-row"
          >
            <TabsList
              variant="line"
              className="w-full shrink-0 flex-row! border-b p-2 sm:h-auto! sm:w-60 sm:flex-col! sm:justify-start sm:gap-1 sm:self-stretch sm:border-r sm:border-b-0 sm:p-3"
            >
              {SETTING_SECTIONS.map((s) => {
                const Icon = ICONS[s.key];
                return (
                  <TabsTrigger
                    key={s.key}
                    value={s.key}
                    className={TAB}
                  >
                    <Icon />
                    {s.label}
                  </TabsTrigger>
                );
              })}
              <TabsTrigger value="business" className={TAB}>
                <Building2Icon />
                Business
              </TabsTrigger>
              <TabsTrigger value="you" className={TAB}>
                <UserIcon />
                You
              </TabsTrigger>
              <TabsTrigger
                value="appearance"
                className={TAB}
              >
                <SunMoonIcon />
                Appearance
              </TabsTrigger>
            </TabsList>
            {SETTING_SECTIONS.map((s) => (
              <TabsContent
                key={s.key}
                value={s.key}
                className="min-h-0 overflow-y-auto p-4 sm:p-6"
              >
                <h3 className="font-medium">{s.label}</h3>
                <p className="mb-4 text-sm text-muted-foreground">{s.help}</p>
                {/* the free trial runs the fast AI whatever Quality says (backend settingsFor) */}
                {data.modelLock && SETTING_FIELDS.some((f) => f.section === s.key && f.key === "modelSet") && (
                  <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm">
                    <span className="min-w-0 flex-1">{data.modelLock}</span>
                    {data.canEdit && <SeePlans size="sm" label="See plans" />}
                  </div>
                )}
                {s.key === "work" && (
                  <>
                    <SetupCard canEdit={data.canEdit} onStarted={() => onOpenChange(false)} />
                    <ImportCard onStarted={() => onOpenChange(false)} />
                  </>
                )}
                {[false, true].map((advanced) => {
                  const picked = MODEL_FIELDS.flatMap((m) => {
                    const v = draft[m.key] ?? data.values[m.key];
                    return v === "auto" ? [] : [{ label: m.label, model: String(v) }];
                  });
                  const fields = SETTING_FIELDS.filter((f) => f.section === s.key && ("advanced" in f) === advanced);
                  if (!fields.length) return null;
                  const card = (
                    <Card>
                      <CardContent className="grid gap-4">
                        {fields.map((f, i) => (
                          <Fragment key={f.key}>
                            {i > 0 && <Separator />}
                            <SettingRow
                              field={f}
                              value={f.key === "modelSet" && picked.length ? CUSTOM : (draft[f.key] ?? data.values[f.key])}
                              fallback={data.defaults[f.key]}
                              disabled={!data.canEdit}
                              models={models.data}
                              auto={autoModel(f, draft.modelSet ?? data.values.modelSet)}
                              note={
                                f.key === "modelSet" && (
                                  <QualityNote
                                    models={models.data}
                                    picked={picked}
                                    onCustomize={() => {
                                      setAdvancedOpen(true);
                                      requestAnimationFrame(() =>
                                        document.getElementById("advanced-models")?.scrollIntoView({ behavior: "smooth", block: "start" }),
                                      );
                                    }}
                                  />
                                )
                              }
                              onChange={(v) =>
                                f.key === "modelSet"
                                  // a Quality choice puts every model back on Auto, so it's what runs
                                  ? v !== CUSTOM && setDraft((d) => ({ ...d, modelSet: v, ...Object.fromEntries(MODEL_FIELDS.map((m) => [m.key, "auto"])) }))
                                  : setDraft((d) => ({ ...d, [f.key]: v }))
                              }
                            />
                          </Fragment>
                        ))}
                      </CardContent>
                    </Card>
                  );
                  return advanced ? (
                    // for whoever on the team wants to pick the models themselves; most never open it
                    <details
                      key="advanced"
                      id="advanced-models"
                      open={advancedOpen}
                      onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
                      className="group mt-4 scroll-mt-4"
                    >
                      <summary className="mb-3 flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                        <ChevronRightIcon className="size-4 transition-transform group-open:rotate-90" />
                        Advanced
                      </summary>
                      {card}
                    </details>
                  ) : (
                    <Fragment key="main">{card}</Fragment>
                  );
                })}
                {s.key === "work" && <AlwaysAllowed />}
              </TabsContent>
            ))}
            <TabsContent value="business" className="min-h-0 overflow-y-auto p-4 sm:p-6">
              <BusinessTab />
            </TabsContent>
            <TabsContent value="you" className="min-h-0 overflow-y-auto p-4 sm:p-6">
              <YouTab />
            </TabsContent>
            <TabsContent value="appearance" className="min-h-0 overflow-y-auto p-4 sm:p-6">
              <Appearance />
            </TabsContent>
          </Tabs>
        )}

        {data?.canEdit && agentTab && (
          <DialogFooter className="m-0 flex-row items-center justify-end rounded-b-xl border-t p-4 sm:px-6">
            {save.error && (
              <p className="mr-auto text-sm text-destructive">
                {save.error.message}
              </p>
            )}
            <Button
              variant="ghost"
              disabled={!changed.length || save.isPending}
              onClick={() => setDraft({})}
            >
              Undo changes
            </Button>
            <Button
              disabled={!changed.length || save.isPending}
              onClick={() =>
                save.mutate(
                  Object.fromEntries(
                    changed.map((f) => [
                      f.key,
                      draft[f.key] === data.defaults[f.key] ? null : draft[f.key],
                    ]),
                  ),
                )
              }
            >
              {save.isPending
                ? "Saving…"
                : changed.length
                  ? `Save ${changed.length} change${changed.length > 1 ? "s" : ""}`
                  : "Save"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "Match this device" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

// Just for this device and this person, so it applies right away, without Save.
function Appearance() {
  const [choice, setChoice] = useState<ThemeChoice>(themeChoice);
  return (
    <>
      <h3 className="font-medium">Appearance</h3>
      <p className="mb-4 text-sm text-muted-foreground">
        Just for you, on this device.
      </p>
      <Card>
        <CardContent className="grid gap-3 sm:grid-cols-[1fr_18rem] sm:gap-6">
          <div className="grid content-start gap-1">
            <Label htmlFor="setting-theme">Theme</Label>
            <p className="text-xs text-muted-foreground">
              &ldquo;Match this device&rdquo; follows your phone or computer.
            </p>
          </div>
          <div className="flex items-start sm:justify-end">
            <Select
              items={THEMES}
              value={choice}
              onValueChange={(v) => {
                if (!v) return;
                setChoice(v);
                setThemeChoice(v);
              }}
            >
              <SelectTrigger id="setting-theme" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="w-auto min-w-(--anchor-width)">
                {THEMES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function SettingRow({
  field: f,
  value,
  fallback,
  disabled,
  models,
  auto,
  note,
  onChange,
}: {
  field: Field;
  value: Value;
  fallback: Value;
  disabled: boolean;
  models?: ModelOption[];
  auto?: string;
  // more under the help text
  note?: React.ReactNode;
  onChange: (value: Value) => void;
}) {
  const id = `setting-${f.key}`;
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_18rem] sm:gap-6">
      <div className="grid content-start gap-1">
        <Label htmlFor={id}>{f.label}</Label>
        <p className="text-xs text-muted-foreground">{f.help}</p>
        {note}
        {value !== fallback && (
        <div className="flex h-6 items-center gap-1 text-xs text-muted-foreground">
          {(
            <>
              Default: {shown(f, fallback, models)}
              {!disabled && (
                <Button
                  variant="link"
                  size="xs"
                  className="px-1"
                  onClick={() => onChange(fallback)}
                >
                  Use default
                </Button>
              )}
            </>
          )}
        </div>
        )}
      </div>
      <div className="flex items-start sm:justify-end">
        {f.type === "toggle" ? (
          <Switch
            id={id}
            checked={Boolean(value)}
            disabled={disabled}
            onCheckedChange={onChange}
          />
        ) : f.type === "model" ? (
          // remounted when the value changes, so the maker follows "Use default"
          <ModelPicker
            key={String(value)}
            id={id}
            value={String(value)}
            auto={auto}
            models={models}
            disabled={disabled}
            onChange={onChange}
          />
        ) : f.type === "key" ? (
          // the saved key comes back masked; typing replaces it, emptying it goes back to ours
          <Input
            id={id}
            type="password"
            autoComplete="off"
            placeholder={f.placeholder}
            value={String(value)}
            disabled={disabled}
            onFocus={(e) => e.target.select()}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : f.type === "choice" ? (
          <div className="grid w-full gap-1.5">
            <Select
              items={optionsOf(f, value)}
              value={String(value)}
              disabled={disabled}
              onValueChange={(v) => v !== null && onChange(v)}
            >
              <SelectTrigger id={id} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="w-auto min-w-(--anchor-width)">
                {optionsOf(f, value).map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* what the picked one means */}
            {(() => {
              const picked = (f.options as readonly { value: string; hint?: string }[]).find((o) => o.value === value);
              return picked?.hint && <p className="px-1 text-xs text-muted-foreground">{picked.hint}</p>;
            })()}
          </div>
        ) : (
          <InputGroup>
            <InputGroupInput
              id={id}
              type="number"
              inputMode="numeric"
              min={f.min}
              max={f.max}
              value={Number.isNaN(value) ? "" : String(value)}
              disabled={disabled}
              onChange={(e) => onChange(e.target.valueAsNumber)}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText>{f.unit}</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
        )}
      </div>
    </div>
  );
}

// Pick the maker, then search its models by name. Each shows its price and how much it can read at once.
function ModelPicker({
  id,
  value,
  auto,
  models,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  // what Auto runs now
  auto?: string;
  models?: ModelOption[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const current = models?.find((m) => m.id === value);
  // a model that isn't in the list (once it's loaded) was typed in by name
  const custom = value !== "auto" && !!models && !current;
  const [picked, setProvider] = useState<string | null>(null);
  const provider = picked ?? (value === "auto" ? "auto" : custom ? "custom" : (current?.provider ?? value.split("/")[0]));
  const [typed, setTyped] = useState(custom ? value : "");
  const applyTyped = () => {
    const id = typed.trim();
    if (id && id !== value) onChange(id);
  };
  const list = models?.filter((m) => m.provider === provider) ?? [];
  const label = PROVIDER_ITEMS.find((p) => p.value === provider)?.label ?? provider;
  return (
    <div className="grid w-full gap-2">
      <Select
        items={PROVIDER_ITEMS}
        value={provider}
        disabled={disabled}
        onValueChange={(v) => {
          if (v === null) return;
          setProvider(v);
          if (v === "auto") onChange("auto");
        }}
      >
        <SelectTrigger aria-label="Provider" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PROVIDER_ITEMS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {provider === "auto" ? (
        <p className="px-1 text-xs text-muted-foreground">
          Now: {models?.find((m) => m.id === auto)?.name ?? (auto === "openrouter/free" ? "Any free model" : auto)}
        </p>
      ) : provider === "custom" ? (
        <div className="grid gap-1.5">
          <Input
            id={id}
            value={typed}
            disabled={disabled}
            placeholder="e.g. deepseek/deepseek-chat-v3.1"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={applyTyped}
            onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), applyTyped())}
          />
          <p className="px-1 text-xs text-muted-foreground">
            Any model on{" "}
            <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
              OpenRouter
            </a>{" "}
            that can use tools, by its exact name.
          </p>
        </div>
      ) : (
      <Combobox
        items={list}
        value={current?.provider === provider ? current : null}
        itemToStringLabel={(m: ModelOption) => m.name}
        isItemEqualToValue={(a: ModelOption, b: ModelOption) => a.id === b.id}
        disabled={disabled || !models}
        onValueChange={(m: ModelOption | null) => m && onChange(m.id)}
      >
        <ComboboxInput
          id={id}
          className="w-full"
          placeholder={models ? `Search ${label} models…` : "Loading models…"}
        />
        <ComboboxContent className="w-auto min-w-(--anchor-width) max-w-[min(26rem,var(--available-width))]">
          <ComboboxEmpty>No model matches.</ComboboxEmpty>
          <ComboboxList>
            {(m: ModelOption) => (
              <ComboboxItem key={m.id} value={m}>
                <span className="grid">
                  <span>{m.name}</span>
                  <span className="text-xs text-muted-foreground">
                    ${m.input} in · ${m.output} out per 1M tokens · {tokens(m.context)} context
                  </span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      )}
    </div>
  );
}

// App actions this person said "Always allow" to in a chat (their own list, whoever can edit the rest)
function AlwaysAllowed() {
  const queryClient = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["always-allowed"], queryFn: () => api<string[]>("/approvals/always") });
  const remove = useMutation({
    mutationFn: (action: string) => api<string[]>(`/approvals/always/${encodeURIComponent(action)}`, undefined, "DELETE"),
    onSuccess: (list) => queryClient.setQueryData(["always-allowed"], list),
  });
  return (
    <>
      <h3 className="mt-6 font-medium">Always allowed</h3>
      <p className="mb-4 text-sm text-muted-foreground">
        Actions it no longer asks you about. Remove one and it asks again.
      </p>
      <Card>
        <CardContent className="grid gap-2">
          {data.length ? (
            data.map((action) => (
              <div key={action} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-mono text-xs">{action}</span>
                <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(action)}>
                  Remove
                </Button>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">None yet.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}

// Day-one setup (backend setup.ts): whether the AI employee has been briefed on the business and its job, and
// a button that opens a new chat to do it (or do it again, to add more).
function SetupCard({ canEdit, onStarted }: { canEdit: boolean; onStarted: () => void }) {
  const { newDraft } = useDraft();
  const router = useRouter();
  const status = useQuery({ queryKey: ["setup"], queryFn: () => api<SetupStatus>("/setup") });
  const start = useMutation({
    mutationFn: () => api<SetupStatus>("/setup/redo", {}),
    onSuccess: () => {
      onStarted();
      sessionStorage.setItem(SAY_TEXT, "Let's do the setup.");
      // always a new chat, so it picks this up even if an empty one is already open
      newDraft();
      router.push("/chat");
    },
  });
  const s = status.data;
  if (!s) return null;
  const when = s.at && new Date(s.at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return (
    <Card className="mb-4">
      <CardContent className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Brief Emplio</div>
          <p className="text-sm text-muted-foreground">
            {s.state === "done"
              ? `Done on ${when}. Run again to add or change anything.`
              : s.state === "skipped"
                ? "Skipped. A few minutes telling it about your business and its job."
                : "A few minutes telling it about your business and its job."}
          </p>
        </div>
        {canEdit && (
          <Button size="sm" variant={s.state === "done" ? "outline" : "default"} disabled={start.isPending} onClick={() => start.mutate()}>
            {s.state === "done" ? "Run again" : "Start"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// Bringing your own memory from ChatGPT, Claude, OpenClaw or Hermes (the /import page); for everyone, not just admins
function ImportCard({ onStarted }: { onStarted: () => void }) {
  const router = useRouter();
  return (
    <Card className="mb-4">
      <CardContent className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Bring your memory</div>
          <p className="text-sm text-muted-foreground">What ChatGPT, Claude, OpenClaw or Hermes knows about you and your work, and your old chats there.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => (onStarted(), router.push("/import"))}>
          Start
        </Button>
      </CardContent>
    </Card>
  );
}

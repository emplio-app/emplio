"use client";

import { DEFAULT_LOGIN_FIELDS, isSecretField, type Login, type LoginInput, type SaveLoginCard } from "@emplio/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, KeyRoundIcon, LockKeyholeIcon } from "lucide-react";
import { useContext, useState } from "react";
import { ChatSendContext } from "@/components/chat/connect-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";

// Saved passwords and keys. They go straight to our server, which keeps them encrypted; the AI employee
// only knows their names and the server fills them in for it (backend logins.ts).

export const loginsQueryKey = ["logins"];
export const useLogins = () => useQuery({ queryKey: loginsQueryKey, queryFn: () => api<Login[]>("/logins") });

// card: what the AI asked for (name and site fixed); without one, the person names it.
export function SaveLoginDialog({ card, onClose, onSaved }: { card?: SaveLoginCard; onClose: () => void; onSaved?: (l: Login) => void }) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState(card?.kind ?? "login");
  const [name, setName] = useState(card?.name ?? "");
  const [site, setSite] = useState(card?.site ?? "");
  // a login asks for just the boxes that site's sign-in page has (the AI read them off it)
  const labels = card?.fields?.length ? card.fields : DEFAULT_LOGIN_FIELDS;
  const [fields, setFields] = useState<Record<string, string>>({});
  const [value, setValue] = useState("");
  const save = useMutation({
    mutationFn: () => api<Login>("/logins", (kind === "login" ? { name, kind, site, fields } : { name, kind, site, value }) satisfies LoginInput),
    onSuccess: (l) => {
      void queryClient.invalidateQueries({ queryKey: loginsQueryKey });
      onSaved?.(l);
      onClose();
    },
  });
  const key = kind === "key";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg border bg-muted">
              {key ? <KeyRoundIcon className="size-4" /> : <LockKeyholeIcon className="size-4" />}
            </div>
            <DialogTitle>{card ? `Save ${key ? "key" : "login"} for ${card.site}` : "Save a login or key"}</DialogTitle>
          </div>
          <DialogDescription>
            Stored encrypted. Emplio {key ? "uses it" : "signs in with it"} for you, only on {site || "that site"}, and never sees it.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {!card && (
            <>
              <Tabs value={kind} onValueChange={(k) => setKind(k as typeof kind)}>
                <TabsList className="w-full">
                  {(["login", "key"] as const).map((k) => (
                    <TabsTrigger key={k} value={k}>
                      {k === "login" ? "Website login" : "API key or token"}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <label className="grid gap-1.5 text-sm font-medium">
                Website
                <Input required placeholder={key ? "api.vercel.com" : "vercel.com"} value={site} onChange={(e) => setSite(e.target.value)} />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Name
                <Input required placeholder={key ? "VERCEL_TOKEN" : "VERCEL"} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            </>
          )}
          {key ? (
            <label className="grid gap-1.5 text-sm font-medium">
              Key or token
              <Input type="password" autoComplete="new-password" autoFocus={!!card} required value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
          ) : (
            labels.map((label, i) => (
              <label key={label} className="grid gap-1.5 text-sm font-medium">
                {label}
                <Input
                  type={isSecretField(label) ? "password" : /^e-?mail( address)?$/i.test(label) ? "email" : /^(phone|mobile)( number)?$/i.test(label) ? "tel" : "text"}
                  autoComplete={isSecretField(label) ? "new-password" : "off"}
                  autoFocus={!!card && i === 0}
                  required={!!card?.fields?.length}
                  value={fields[label] ?? ""}
                  onChange={(e) => setFields((f) => ({ ...f, [label]: e.target.value }))}
                />
              </label>
            ))
          )}
          {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || (key ? !value : !Object.values(fields).some(Boolean))}>
              {save.isPending && <Spinner className="size-3.5" />}
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// The button the chat shows when the AI asks to save one (emplio logins ask). Once saved, it tells the chat.
export function SaveLoginCardView({ card }: { card: SaveLoginCard }) {
  const [open, setOpen] = useState(false);
  const { data } = useLogins();
  const [savedNow, setSavedNow] = useState(false);
  const send = useContext(ChatSendContext);
  const saved = savedNow || !!data?.some((l) => l.name === card.name);
  const key = card.kind === "key";
  return (
    <div className="flex w-full max-w-sm items-center gap-3 rounded-xl border bg-card p-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted">
        {key ? <KeyRoundIcon className="size-4" /> : <LockKeyholeIcon className="size-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{card.site}</div>
        <div className="truncate text-xs text-muted-foreground">
          {saved ? `Saved as ${card.name}` : key ? "Save the key so I can use it, without seeing it" : "Save the login so I sign in for you"}
        </div>
      </div>
      {saved ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
          <CheckIcon className="size-3.5" /> Saved
        </span>
      ) : (
        <Button size="sm" onClick={() => setOpen(true)}>
          Save
        </Button>
      )}
      {open && (
        <SaveLoginDialog
          card={card}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setSavedNow(true);
            send?.(`I've saved the ${key ? "key" : "login"} for ${card.site}.`);
          }}
        />
      )}
    </div>
  );
}

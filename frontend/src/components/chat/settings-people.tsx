"use client";

// Settings' Business and You tabs: the business's name (owner and admins change it) and the person's own name, email
// and phone. Each saves on its own, at once; Emplio can change the same with `emplio settings`, after an Allow.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { DangerZone } from "@cloud/client";
import { ChannelsDialog } from "@/components/chat/channels-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ClientPicker as SearchPicker } from "@/components/clients/client-picker";
import { api, meQueryKey, useMe } from "@/lib/api";

function NameRow({ id, label, help, saved, disabled, save }: { id: string; label: string; help: string; saved: string; disabled?: boolean; save: (name: string) => Promise<unknown> }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(saved);
  const m = useMutation({ mutationFn: () => save(name.trim()), onSuccess: () => queryClient.invalidateQueries({ queryKey: meQueryKey }) });
  const dirty = !!name.trim() && name.trim() !== saved;
  return (
    <form className="grid gap-3 sm:grid-cols-[1fr_18rem] sm:gap-6" onSubmit={(e) => (e.preventDefault(), dirty && m.mutate())}>
      <div className="grid content-start gap-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{help}</p>
        {m.error && <p className="text-xs text-destructive">{m.error.message}</p>}
      </div>
      <div className="flex gap-2">
        <Input id={id} value={name} maxLength={100} disabled={disabled} onChange={(e) => setName(e.target.value)} />
        {dirty && (
          <Button type="submit" disabled={m.isPending}>
            Save
          </Button>
        )}
      </div>
    </form>
  );
}

// the currency prices and fees are in: picked by typing (USD, euro, rupee)
const CURRENCIES = (() => {
  const names = new Intl.DisplayNames(undefined, { type: "currency" });
  return Intl.supportedValuesOf("currency").map((c) => ({ value: c, label: `${names.of(c) ?? c} (${c})` }));
})();
function CurrencyRow({ id, saved, disabled }: { id: string; saved: string; disabled: boolean }) {
  const queryClient = useQueryClient();
  const m = useMutation({ mutationFn: (currency: string) => api(`/workspaces/${id}`, { currency }, "PATCH"), onSuccess: () => queryClient.invalidateQueries({ queryKey: meQueryKey }) });
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_18rem] sm:gap-6">
      <div className="grid content-start gap-1">
        <Label>Currency</Label>
        <p className="text-xs text-muted-foreground">What your prices and fees are in. Ones already written down keep theirs.</p>
        {m.error && <p className="text-xs text-destructive">{m.error.message}</p>}
      </div>
      {disabled ? (
        <Input value={CURRENCIES.find((c) => c.value === saved)?.label ?? saved} disabled />
      ) : (
        <SearchPicker items={CURRENCIES} value={saved} label="Currency" search="Search currencies" empty="No currency matches." onChange={(c) => c !== saved && m.mutate(c)} className="w-full" />
      )}
    </div>
  );
}

export function BusinessTab() {
  const business = useMe().data?.workspaces[0];
  if (!business) return null;
  const canEdit = business.role !== "member";
  return (
    <>
      <h3 className="font-medium">Business</h3>
      <p className="mb-4 text-sm text-muted-foreground">{canEdit ? "For everyone in the business." : "Only the owner or an admin can change this."}</p>
      <Card>
        <CardContent>
          <NameRow
            key={business.id}
            id="business-name"
            label="Business name"
            help="What the team and Emplio call it."
            saved={business.name}
            disabled={!canEdit}
            save={(name) => api(`/workspaces/${business.id}`, { name }, "PATCH")}
          />
          <CurrencyRow id={business.id} saved={business.currency} disabled={!canEdit} />
        </CardContent>
      </Card>
    </>
  );
}

export function YouTab() {
  const user = useMe().data?.user;
  const [channels, setChannels] = useState(false);
  if (!user) return null;
  return (
    <>
      <h3 className="font-medium">You</h3>
      <p className="mb-4 text-sm text-muted-foreground">Just you, in every business you&apos;re in.</p>
      <Card>
        <CardContent className="grid gap-4">
          <NameRow id="your-name" label="Your name" help="How the team and Emplio see you." saved={user.name ?? ""} save={(name) => api("/me/name", { name })} />
          <div className="grid gap-3 sm:grid-cols-[1fr_18rem] sm:gap-6">
            <div className="grid content-start gap-1">
              <Label htmlFor="your-email">Email</Label>
              <p className="text-xs text-muted-foreground">You sign in with this.</p>
            </div>
            <Input id="your-email" value={user.email} disabled />
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_18rem] sm:gap-6">
            <div className="grid content-start gap-1">
              <span className="text-sm font-medium">Phone and Telegram</span>
              <p className="text-xs text-muted-foreground">Your mobile number, and Emplio on your phone.</p>
            </div>
            <Button variant="outline" onClick={() => setChannels(true)}>
              Open
            </Button>
          </div>
        </CardContent>
      </Card>
      <ChannelsDialog open={channels} onOpenChange={setChannels} />
      <DangerZone />
    </>
  );
}

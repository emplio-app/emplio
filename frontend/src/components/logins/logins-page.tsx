"use client";

import type { OnePasswordStatus, SaveLoginCard } from "@emplio/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, KeyRoundIcon, LockKeyholeIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { AppLogo, useConnect, useConnections } from "@/components/chat/connect-card";
import { loginsQueryKey, SaveLoginDialog, useLogins } from "@/components/logins/save-login";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useConfirm } from "@/components/confirm";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";

const when = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

// Passwords and keys the AI employee may use for this person. A link from the AI on a phone lands here with
// ?save=NAME&site=…&kind=…&fields=Email,Password, which opens the form straight away.
export function LoginsPage() {
  const queryClient = useQueryClient();
  const { data, isPending } = useLogins();
  const [asked, setAsked] = useState<SaveLoginCard | null>(null);
  const [adding, setAdding] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const name = q.get("save");
    const site = q.get("site");
    const fields = q.get("fields")?.split(",").filter(Boolean).slice(0, 6);
    if (name && site) setAsked({ name, site, kind: q.get("kind") === "key" ? "key" : "login", ...(fields?.length ? { fields } : {}) });
  }, []);
  // 1Password: connected here or in Integrations, its logins list below with the saved ones
  const onePassword = useQuery({ queryKey: [...loginsQueryKey, "onepassword"], queryFn: () => api<OnePasswordStatus>("/logins/onepassword") });
  const { connect, connecting, keyDialog } = useConnect();
  const connections = useConnections();
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: loginsQueryKey });
  }, [connections.dataUpdatedAt, queryClient]);
  const op = onePassword.data;
  const connectOnePassword = () =>
    op && connect({ app: "onepassword", name: "1Password", logo: "/logos/onepassword.svg", keyField: op.keyField, connection: op.connection ?? undefined });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/logins/${id}`, undefined, "DELETE"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: loginsQueryKey }),
  });

  const [confirmDialog, confirm] = useConfirm();

  return (
    <div className="flex h-full min-h-0 flex-col">
      {confirmDialog}
      {keyDialog}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <h1 className="px-2 font-sans text-sm font-medium tracking-normal">Passwords & keys</h1>
        <Button size="sm" className="ml-auto gap-1.5" onClick={() => setAdding(true)}>
          <PlusIcon className="size-3.5" /> Add
        </Button>
      </header>
      <div className="under-tabs min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-6">
          {done && (
            <div className="flex items-start gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
              <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-primary" />
              <div>
                <div className="font-medium">Saved {done}.</div>
                <div className="text-muted-foreground">Go back to the chat and tell Emplio it&apos;s saved.</div>
              </div>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            Kept encrypted. Emplio signs in or uses a key for you by its name, only on its own site, and never sees what you typed.
          </p>
          {op && (
            <div className={`flex items-center gap-3 rounded-xl border p-3 text-sm ${op.connection ? "" : "border-dashed"}`}>
              <AppLogo src="/logos/onepassword.svg" className="size-9" />
              <div className="min-w-0 flex-1">
                {op.connection ? (
                  <>
                    <div className="font-medium">1Password connected{op.label ? ` · ${op.label}` : ""}</div>
                    <div className={op.error ? "text-destructive" : "text-muted-foreground"}>
                      {op.error ??
                        `${op.items} ${op.items === 1 ? "login" : "logins and keys"} Emplio can use${op.skipped ? `, ${op.skipped} left out (add a website to an item in 1Password to use it)` : ""}`}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="font-medium">Keep your passwords in 1Password?</div>
                    <div className="text-muted-foreground">Connect it and Emplio uses them from there, without seeing them.</div>
                  </>
                )}
              </div>
              <Button size="sm" variant="outline" disabled={connecting === (op.connection ?? "onepassword")} onClick={connectOnePassword}>
                {op.connection ? "Replace token" : "Connect"}
              </Button>
            </div>
          )}
          {isPending ? (
            <Skeleton className="h-32 rounded-xl" />
          ) : !data?.length ? (
            <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Nothing saved yet.</div>
          ) : (
            <ul className="divide-y rounded-xl border">
              {data.map((l) => (
                <li key={l.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted">
                    {l.kind === "key" ? <KeyRoundIcon className="size-4" /> : <LockKeyholeIcon className="size-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{l.site}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[l.name, l.username, l.from === "1password" ? "from 1Password" : l.usedAt ? `used ${when(l.usedAt)}` : "not used yet"].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  {l.from !== "1password" && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="text-muted-foreground"
                      aria-label={`Delete ${l.name}`}
                      disabled={remove.isPending}
                      onClick={() =>
                        confirm({
                          title: `Delete ${l.name}?`,
                          description: "Emplio won't be able to use it any more.",
                          onConfirm: () => remove.mutate(l.id),
                        })
                      }
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {(asked || adding) && (
        <SaveLoginDialog
          card={asked ?? undefined}
          onClose={() => {
            setAsked(null);
            setAdding(false);
            window.history.replaceState(null, "", "/logins");
          }}
          onSaved={(l) => setDone(l.name)}
        />
      )}
    </div>
  );
}

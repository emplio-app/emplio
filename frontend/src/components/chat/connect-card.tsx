"use client";

import type { ConnectCard as Card, Connection, KeyField, McpServer } from "@emplio/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, PlugIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, API_URL } from "@/lib/api";

export const connectionsQueryKey = ["connections"];

// Sends a message in the open chat as the person, so a card can say "connected" for them.
export const ChatSendContext = createContext<((text: string) => void) | null>(null);

// The person's connected apps; refetched when they come back from signing in.
export const useConnections = (enabled = true) =>
  useQuery({ queryKey: connectionsQueryKey, queryFn: () => api<Connection[]>("/connections"), enabled });

// connection: reconnect that account; without it, another account is added
type Target = { app: string; name?: string; logo?: string; keyField?: KeyField; signIn?: boolean; path?: string; connection?: string };

// Connect an app. Most sign in in a small window over this one, through our own /connect link; the window
// closes itself when done and this one refreshes once it's back in focus (popups blocked: the whole page
// goes). Apps that take a key get a form instead: render `keyDialog` wherever the hook is used.
// `connecting` is the connection being reconnected, or the app being added.
export function useConnect() {
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState<string | null>(null);
  const [asking, setAsking] = useState<Target | null>(null);
  const signIn = ({ app, connection, path = `/connect/${app}${connection ? `?connection=${connection}` : ""}` }: Target) => {
    const url = new URL(API_URL + path);
    url.searchParams.set("popup", "1");
    const left = window.screenX + (window.outerWidth - 520) / 2;
    const win = window.open(url.href, `connect-${app}`, `popup,width=520,height=720,left=${left},top=${window.screenY + 60}`);
    if (!win) {
      window.location.href = API_URL + path;
      return;
    }
    setConnecting(connection ?? app);
    // not win.closed: sign-in pages cut the link to their opener, so it reads closed at once
    setTimeout(
      () =>
        window.addEventListener(
          "focus",
          () => {
            setConnecting(null);
            void queryClient.invalidateQueries({ queryKey: connectionsQueryKey });
            void queryClient.invalidateQueries({ queryKey: ["mcp"] });
          },
          { once: true },
        ),
      300,
    );
  };
  const connect = (target: Target) => (target.keyField ? setAsking(target) : signIn(target));
  const keyDialog = asking && (
    <KeyDialog
      target={asking}
      onSignIn={() => {
        signIn(asking);
        setAsking(null);
      }}
      onClose={() => setAsking(null)}
    />
  );
  return { connect, connecting, keyDialog };
}

// The form for an app connected with a key, and the sign-in button of one that takes both. The key goes straight
// to our server, which checks it with the app and keeps it encrypted; the AI employee never sees it.
function KeyDialog({ target, onSignIn, onClose }: { target: Target; onSignIn: () => void; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: () => api("/connections", { app: target.app, key, connection: target.connection }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: connectionsQueryKey });
      onClose();
    },
  });
  const field = target.keyField!;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <AppLogo src={target.logo} className="size-9" />
            <DialogTitle>Connect {target.name ?? target.app}</DialogTitle>
          </div>
          <DialogDescription>{target.signIn ? `Sign in with ${target.name ?? target.app}, or paste a key instead.` : field.help}</DialogDescription>
        </DialogHeader>
        {target.signIn && (
          <>
            <Button type="button" className="w-full" onClick={onSignIn}>
              Sign in with {target.name ?? target.app}
            </Button>
            <p className="text-xs text-muted-foreground">{field.help}</p>
          </>
        )}
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            {field.label}
            <Input
              type="password"
              autoComplete="off"
              autoFocus
              required
              placeholder={field.placeholder}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">Stored encrypted. Emplio uses it but never sees it.</p>
          {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || !key.trim()}>
              {save.isPending && <Spinner className="size-3.5" />}
              {save.isPending ? "Checking…" : "Connect"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AppLogo({ src, className = "size-10" }: { src?: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-white ${className}`}>
      {src && !broken ? (
        // /favicon is the API's (an MCP server's favicon, mcpLogo); other paths, like /logos/*, are this app's
        // eslint-disable-next-line @next/next/no-img-element -- remote logo, any host
        <img src={src.startsWith("/favicon") ? `${API_URL}${src}` : src} alt="" className="size-[65%] object-contain" onError={() => setBroken(true)} />
      ) : (
        <PlugIcon className="size-1/2 text-muted-foreground" />
      )}
    </div>
  );
}

export function ConnectButton({ busy, onClick, label = "Connect" }: { busy: boolean; onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-70"
    >
      {busy && <Spinner className="size-3" />}
      {busy ? "Waiting…" : label}
    </button>
  );
}

// count: accounts connected, shown when more than one
export const ConnectedMark = ({ count = 1 }: { count?: number }) => (
  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
    <CheckIcon className="size-3.5" /> Connected{count > 1 && ` (${count})`}
  </span>
);

// An app the agent asked someone to connect: logo, name, and a button to our own sign-in link.
// Turns into "Connected" once it is: the account it reconnects, or an account added since the card was made.
export function ConnectCard({ card }: { card: Card }) {
  const { data } = useConnections();
  // an MCP server's own sign-in (backend/src/mcp.ts): done once the person has signed in to it
  const mcp = useQuery({ queryKey: ["mcp"], queryFn: () => api<{ servers: McpServer[] }>("/mcp"), enabled: !!card.mcp });
  const { connect, connecting, keyDialog } = useConnect();
  const done = card.mcp
    ? mcp.data?.servers.some((s) => s.name === card.app && s.signedIn)
      ? { label: card.name }
      : undefined
    : data?.find((c) => c.app === card.app && c.status === "active" && (card.connection ? c.id === card.connection : !card.existing?.includes(c.id)));
  const connected = !!done;
  // once connected from this card, tell the chat so the AI employee carries on
  const send = useContext(ChatSendContext);
  const started = useRef(false);
  useEffect(() => {
    if (!done || !started.current) return;
    started.current = false;
    send?.(card.mcp ? `I've signed in to ${card.name}.` : `I've connected ${card.name}${done.label !== card.name ? ` (${done.label})` : ""}.`);
  }, [done, send, card.name]);
  return (
    <div className="flex w-full max-w-sm items-center gap-3 rounded-xl border bg-card p-3">
      <AppLogo src={card.logo} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{card.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {done
            ? `Ready to use · ${done.label}`
            : card.existing?.length && !card.connection
              ? "Connect another account"
              : card.keyField && !card.signIn
                ? `Add your ${card.keyField.label} so I can use it`
                : "Sign in so I can use it for you"}
        </div>
      </div>
      {connected ? (
        <ConnectedMark />
      ) : (
        <ConnectButton
          busy={connecting === (card.connection ?? card.app)}
          onClick={() => {
            started.current = true;
            connect(card);
          }}
        />
      )}
      {keyDialog}
    </div>
  );
}

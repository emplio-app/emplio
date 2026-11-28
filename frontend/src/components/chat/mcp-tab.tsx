"use client";

import { mcpLogo, type ConnectCard, type McpServer, type McpServerInput, type McpTool } from "@emplio/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontalIcon, PlusIcon, ServerIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { AppLogo, useConnect } from "@/components/chat/connect-card";
import { useConfirm } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";

const KEY = ["mcp"];
const EMPTY: McpServerInput = { name: "", url: "", headers: [], enabled: true };

// The business's MCP servers (backend/src/mcp.ts): shared by the whole team; the owner and admins add them here or
// by asking the AI. Each one's tools are checked live (Check), as the person looking.
export function McpTab() {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: KEY, queryFn: () => api<{ servers: McpServer[]; canEdit: boolean }>("/mcp") });
  const [editing, setEditing] = useState<{ id?: string; value: McpServerInput } | null>(null);
  // a server's tools, why it failed, or the sign-in it wants first
  const [checked, setChecked] = useState<Record<string, McpTool[] | string | ConnectCard>>({});
  const { connect, connecting } = useConnect();
  const [confirmDialog, confirm] = useConfirm();
  const refresh = () => queryClient.invalidateQueries({ queryKey: KEY });
  const save = useMutation({
    mutationFn: ({ id, value }: { id?: string; value: McpServerInput }) => api<McpServer>(id ? `/mcp/${id}` : "/mcp", value, id ? "PUT" : "POST"),
    onSuccess: (s) => {
      setEditing(null);
      void check(s.id);
    },
    onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/mcp/${id}`, undefined, "DELETE"), onSettled: refresh });
  const toggle = useMutation({ mutationFn: (s: McpServer) => api(`/mcp/${s.id}`, { ...s, enabled: !s.enabled }, "PUT"), onSettled: refresh });
  const check = (id: string) =>
    api<{ tools?: McpTool[]; signIn?: ConnectCard }>(`/mcp/${id}/tools`).then(
      (r) => setChecked((c) => ({ ...c, [id]: r.tools ?? r.signIn! })),
      (e: Error) => setChecked((c) => ({ ...c, [id]: e.message })),
    );

  if (list.isPending)
    return (
      <div className="grid gap-3 p-5">
        <Skeleton className="h-14 rounded-lg" />
        <Skeleton className="h-14 rounded-lg" />
      </div>
    );
  if (list.error) return <p className="p-5 text-sm text-destructive">{list.error.message}</p>;
  const { servers, canEdit } = list.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
      <p className="mb-3 text-sm text-muted-foreground">
        Tools from other services, added by their MCP address. The whole team&apos;s AI can use them.
        {!canEdit && " Only the owner or an admin can add them."}
      </p>
      {!servers.length && !editing && (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-muted">
            <ServerIcon className="size-5 text-muted-foreground" />
          </div>
          <div className="text-sm text-muted-foreground">No MCP servers yet.</div>
        </div>
      )}
      <ul className="divide-y">
        {servers.map((s) => {
          const tools = checked[s.id];
          return editing?.id === s.id ? (
            <li key={s.id} className="py-3">
              <ServerForm value={editing.value} onChange={(value) => setEditing({ id: s.id, value })} saving={save.isPending} error={save.error?.message} onCancel={() => setEditing(null)} onSave={() => save.mutate(editing)} />
            </li>
          ) : (
            <li key={s.id} className="flex items-center gap-3 py-3">
              <AppLogo key={s.url} src={mcpLogo(s.url)} className="size-9" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{s.name}</div>
                <div className="truncate text-xs text-muted-foreground">{s.url}</div>
                {tools !== undefined && (
                  <div className={`truncate text-xs ${typeof tools === "string" ? "text-destructive" : "text-muted-foreground"}`}>
                    {typeof tools === "string"
                      ? tools
                      : Array.isArray(tools)
                        ? `${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`
                        : "Needs you to sign in"}
                  </div>
                )}
              </div>
              {tools && typeof tools === "object" && !Array.isArray(tools) && !s.signedIn ? (
                <Button size="sm" disabled={connecting === s.name} onClick={() => connect(tools)}>
                  Sign in
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => check(s.id)}>
                  Check
                </Button>
              )}
              {canEdit && (
                <>
                  <Switch checked={s.enabled} onCheckedChange={() => toggle.mutate(s)} aria-label={`Use ${s.name}`} />
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`Manage ${s.name}`} />}>
                      <MoreHorizontalIcon />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => {
                          save.reset();
                          setEditing({ id: s.id, value: { name: s.name, url: s.url, headers: s.headers, enabled: s.enabled } });
                        }}
                      >
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() =>
                          confirm({
                            title: `Remove ${s.name}?`,
                            description: "Emplio won't be able to use its tools any more.",
                            action: "Remove",
                            onConfirm: () => remove.mutate(s.id),
                          })
                        }
                      >
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {canEdit &&
        (editing && !editing.id ? (
          <div className="mt-3 rounded-lg border p-3">
            <ServerForm value={editing.value} onChange={(value) => setEditing({ value })} saving={save.isPending} error={save.error?.message} onCancel={() => setEditing(null)} onSave={() => save.mutate(editing)} />
          </div>
        ) : (
          !editing && (
            <Button
              variant="outline"
              className="mt-3 self-start"
              onClick={() => {
                save.reset();
                setEditing({ value: EMPTY });
              }}
            >
              <PlusIcon /> Add MCP server
            </Button>
          )
        ))}
      {confirmDialog}
    </div>
  );
}

function ServerForm({
  value,
  onChange,
  saving,
  error,
  onCancel,
  onSave,
}: {
  value: McpServerInput;
  onChange: (v: McpServerInput) => void;
  saving: boolean;
  error?: string;
  onCancel: () => void;
  onSave: () => void;
}) {
  const setHeader = (i: number, h: { name: string; value: string }) => onChange({ ...value, headers: value.headers.map((x, j) => (j === i ? h : x)) });
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
        <Input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="Name, like notion" aria-label="Name" autoFocus />
        {/* the site's icon shows as soon as the address is one */}
        <div className="flex items-center gap-2">
          <AppLogo key={mcpLogo(value.url)} src={mcpLogo(value.url) || undefined} className="size-9" />
          <Input value={value.url} onChange={(e) => onChange({ ...value, url: e.target.value })} placeholder="https://mcp.example.com/mcp" aria-label="Address" />
        </div>
      </div>
      {value.headers.map((h, i) => (
        <div key={i} className="grid grid-cols-[10rem_1fr_auto] gap-2">
          <Input value={h.name} onChange={(e) => setHeader(i, { ...h, name: e.target.value })} placeholder="Authorization" aria-label="Header name" />
          <Input type="password" value={h.value} onChange={(e) => setHeader(i, { ...h, value: e.target.value })} placeholder="Bearer …" aria-label="Header value" />
          <Button type="button" variant="ghost" size="icon" aria-label="Remove header" onClick={() => onChange({ ...value, headers: value.headers.filter((_, j) => j !== i) })}>
            <XIcon />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange({ ...value, headers: [...value.headers, { name: "", value: "" }] })}>
          <PlusIcon /> Header
        </Button>
        <span className="text-xs text-muted-foreground">For a token. Use {"{{NAME}}"} for each person&apos;s own saved key.</span>
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving || !value.name.trim() || !value.url.trim()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

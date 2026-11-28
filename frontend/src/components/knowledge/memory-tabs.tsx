"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/api";

// Memory is four pages, notes (Knowledge), the Brain (the notes and records as a map), Files and Database: one place in the sidebar, switched here.
export function MemoryTabs() {
  const pathname = usePathname();
  const { data: me } = useMe();
  // the server refuses staff anyway; this just doesn't offer them a tab that would say so
  const role = me?.workspaces[0]?.role;
  return (
    <nav className="flex items-center gap-1" aria-label="Memory" data-tip="memory-page" data-tip-side="bottom">
      {[
        { href: "/knowledge", label: "Notes" },
        { href: "/brain", label: "Brain" },
        { href: "/files", label: "Files" },
        ...(role && role !== "member" ? [{ href: "/database", label: "Database" }] : []),
      ].map((t) => (
        <Button key={t.href} size="sm" variant={pathname.startsWith(t.href) ? "secondary" : "ghost"} nativeButton={false} render={<Link href={t.href} />}>
          {t.label}
        </Button>
      ))}
    </nav>
  );
}

"use client";

import { CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/utils";

// A field's value, copied in one click: shows on the right of its row while it's hovered (the row is a `group`)
export function CopyButton({ value, label }: { value: string; label: string }) {
  if (!value.trim()) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={`Copy ${label}`}
      className="absolute top-1/2 right-1 -translate-y-1/2 bg-background/80 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => copyText(value.trim()).then(() => toast.success(`Copied ${label.toLowerCase()}`), () => toast.error("Couldn't copy it. Select the text and copy it instead."))}
    >
      <CopyIcon />
    </Button>
  );
}

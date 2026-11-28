"use client";

import { Building2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger, ComboboxValue } from "@/components/ui/combobox";
import { cn } from "@/lib/utils";

type Item = { value: string; label: string };

// Pick one client by typing part of the name: a button like a select, with a search box at the top of its list.
export function ClientPicker({ items, value, onChange, size, icon, className, label = "Client", search = "Search clients", empty = "No client matches.", defaultOpen, onClose }: { items: Item[]; value: string; onChange: (value: string) => void; size?: "sm"; icon?: boolean; className?: string; label?: string; search?: string; empty?: string; defaultOpen?: boolean; onClose?: () => void }) {
  const current = items.find((i) => i.value === value) ?? null;
  return (
    <Combobox autoHighlight defaultOpen={defaultOpen} onOpenChange={(open) => !open && onClose?.()} items={items} value={current} onValueChange={(i: Item | null) => i && onChange(i.value)} itemToStringLabel={(i: Item) => i.label} isItemEqualToValue={(a: Item, b: Item) => a.value === b.value}>
      <ComboboxTrigger aria-label={label} render={<Button variant="outline" size={size} className={cn("justify-between gap-2 font-normal", className)} />}>
        <span className="flex min-w-0 items-center gap-2">
          {icon && <Building2Icon className="shrink-0 text-muted-foreground" />}
          <span className="truncate"><ComboboxValue /></span>
        </span>
      </ComboboxTrigger>
      <ComboboxContent className="w-auto min-w-(--anchor-width) max-w-80">
        <ComboboxInput showTrigger={false} placeholder={search} />
        <ComboboxEmpty>{empty}</ComboboxEmpty>
        <ComboboxList>
          {(i: Item) => (
            <ComboboxItem key={i.value} value={i}>
              <span className="truncate">{i.label}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

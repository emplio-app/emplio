import type { Service, StageCategory } from "@emplio/shared";
import { useProcesses } from "@/lib/api";

export const CATEGORY: Record<StageCategory, { label: string; many: string; hint: string }> = {
  prospect: { label: "Prospect", many: "Prospects", hint: "Not won yet" },
  active: { label: "Active", many: "Active", hint: "Working with them now" },
  past: { label: "Past", many: "Past", hint: "No longer working together" },
};

// a field that looks like text until it's hovered or clicked
export const QUIET =
  "h-8 min-w-0 border-transparent bg-transparent px-2 shadow-none hover:bg-muted focus-visible:border-input focus-visible:bg-background dark:bg-transparent dark:hover:bg-muted";

// The title of the process adding a project for this service starts; nothing when it has none (or it's gone)
export function useStartsProcess(service: Pick<Service, "process"> | undefined) {
  const processes = useProcesses().data;
  return service?.process ? processes?.find((p) => p.name === service.process)?.title : undefined;
}

// The server's "started "X" for it" as a toast line
export const startedText = (s: string | null) =>
  !s ? undefined : s.startsWith("started") ? `S${s.slice(1)}` : "Its process didn't start. Ask Emplio to check it.";

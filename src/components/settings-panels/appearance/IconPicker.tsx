import React from "react";
import { ChevronDown } from "lucide-react";
import type { IconName } from "@/lib/messageRenderingConfig";
import { ALLOWED_ICONS } from "@/lib/messageRenderingConfig";
import { Popover } from "@/components/ui/popover";
import { IconRenderer } from "./iconMap";
import { cn } from "@/lib/utils";

// Sort once at module load. "none" pinned at the top; the rest alphabetical
// (case-insensitive) so the picker grid is browseable.
const SORTED_ICONS: readonly IconName[] = (() => {
  const rest = (ALLOWED_ICONS as readonly IconName[]).filter((n) => n !== "none");
  rest.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return (ALLOWED_ICONS as readonly IconName[]).includes("none" as IconName)
    ? (["none" as IconName, ...rest])
    : rest;
})();

/**
 * Popover-based icon picker with a 6-column grid. Sorted alphabetically with
 * "none" pinned at the top. Shared by the message-kind editor and the tab
 * status-indicator editor.
 */
export const IconPicker: React.FC<{ value: IconName; onChange: (v: IconName) => void }> = ({
  value,
  onChange,
}) => {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      className="p-2 w-[28rem] bg-background"
      triggerClassName="relative block w-full"
      trigger={
        <button
          type="button"
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm ring-offset-background hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring"
          aria-label="Icon"
        >
          <span className="flex items-center gap-2">
            {value === "none" ? (
              <span className="text-muted-foreground text-xs">—</span>
            ) : (
              <IconRenderer name={value} className="h-4 w-4" />
            )}
            <span>{value}</span>
          </span>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </button>
      }
      content={
        <div
          className="grid grid-cols-6 gap-1 max-h-96 overflow-y-auto"
          role="listbox"
          aria-label="Icon"
        >
          {SORTED_ICONS.map((name) => {
            const selected = name === value;
            return (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={selected}
                title={name}
                onClick={() => { onChange(name); setOpen(false); }}
                className={cn(
                  "flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-md border border-transparent bg-popover px-1 hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring",
                  selected && "border-primary bg-accent",
                )}
              >
                {name === "none" ? (
                  <span className="text-muted-foreground text-sm">—</span>
                ) : (
                  <IconRenderer name={name} className="h-5 w-5" />
                )}
                <span
                  className="block w-full truncate text-center leading-tight text-muted-foreground"
                  style={{ fontSize: "9px" }}
                >
                  {name}
                </span>
              </button>
            );
          })}
        </div>
      }
    />
  );
};

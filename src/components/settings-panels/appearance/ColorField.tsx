import React, { useEffect, useState } from "react";
import { Undo2 } from "lucide-react";
import { isHexColor } from "@/lib/messageRenderingConfig";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";


/** A nullable color: native picker plus hex field, with a reset to unset.
 *  Used across Settings › Chats. */
export const ColorField: React.FC<{
  name: string;
  /** What an unset value means here — the theme's look, or automatic text. */
  unsetLabel?: string;
  value: string | null;
  onChange: (next: string | null) => void;
  /** With both, an Enabled checkbox beside the title; off disables the
   *  inputs (the caller decides what off draws). */
  enabled?: boolean;
  onEnabledChange?: (next: boolean) => void;
  /** The visible title; `${name} color` unless a heading already says so. */
  title?: string;
}> = ({ name, unsetLabel = "theme default", value, onChange, enabled, onEnabledChange, title = `${name} color` }) => {
  const hasToggle = enabled !== undefined && onEnabledChange !== undefined;
  const off = hasToggle && !enabled;
  const lower = name.toLowerCase();
  // Local text so a half-typed hex is not bounced; only a valid one commits.
  const [text, setText] = useState(value ?? "");
  useEffect(() => { setText(value ?? ""); }, [value]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label>{title}</Label>
          {hasToggle && (
            <label className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => { onEnabledChange(e.target.checked); }}
                aria-label={`${name} color enabled`}
                className="h-3 w-3 cursor-pointer accent-foreground"
              />
              Enabled
            </label>
          )}
        </div>
        {value !== null ? (
          <button
            type="button"
            onClick={() => { onChange(null); }}
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
            aria-label={`Reset ${lower} color`}
          >
            <Undo2 className="h-3 w-3" />
            Reset to {unsetLabel}
          </button>
        ) : (
          <span className="text-[10px] text-muted-foreground/70 italic">{unsetLabel}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="color"
          // The native picker takes only #rrggbb; alpha lives in the hex field.
          value={value ? toPickerHex(value) : "#888888"}
          onChange={(e) => { onChange(e.target.value.toLowerCase()); }}
          className={cn(
            "h-9 w-12 cursor-pointer rounded-md border border-border",
            "bg-background p-1",
            "focus:outline-none focus:ring-1 focus:ring-ring",
          )}
          aria-label={`${name} color picker`}
          disabled={off}
        />
        <Input
          value={text}
          placeholder={unsetLabel}
          onChange={(e) => {
            const v = e.target.value.trim();
            setText(v);
            if (isHexColor(v)) onChange(v.toLowerCase());
          }}
          className="font-mono text-xs h-9 min-w-0 flex-1"
          aria-label={`${name} color hex`}
          disabled={off}
        />
      </div>
    </div>
  );
};

/** `#rgb` / `#rrggbbaa` → `#rrggbb`, the only form `<input type="color">` accepts. */
function toPickerHex(hex: string): string {
  if (hex.length === 4) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toLowerCase();
  }
  return hex.slice(0, 7).toLowerCase();
}

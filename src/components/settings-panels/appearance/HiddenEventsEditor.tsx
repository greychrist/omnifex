import React, { useEffect, useState } from "react";
import { ChevronsUpDown, Undo2 } from "lucide-react";
import { isHexColor, type HiddenEventsStyle } from "@/lib/messageRenderingConfig";
import { currentThemeBackdrop, hiddenEventsColors } from "@/lib/accentStyle";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface HiddenEventsEditorProps {
  value: HiddenEventsStyle;
  onChange: (next: HiddenEventsStyle) => void;
}

/**
 * Appearance → Message kinds → Hidden events. The compact-mode expander takes
 * a background and a border independently rather than one accent, so each
 * can be pushed far enough to stand out. Blank means the theme's own look.
 */
export const HiddenEventsEditor: React.FC<HiddenEventsEditorProps> = ({ value, onChange }) => {
  const preview = hiddenEventsColors(value, currentThemeBackdrop());
  return (
    <div className="space-y-6" data-testid="hidden-events-editor">
      <header>
        <h4 className="text-heading-4">Hidden events</h4>
        <p className="text-caption text-muted-foreground mt-1">
          The bar compact mode folds hidden messages into. Leave a colour unset to keep
          the theme's look; hex with alpha (<span className="font-mono">#rrggbbaa</span>) sets its strength.
        </p>
      </header>

      <div>
        <Label className="mb-2 block">Sample</Label>
        <div className="rounded-md border border-border bg-background p-4">
          <div
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-md",
              "border border-border/40 bg-muted/20 px-3 py-1.5",
            )}
            style={preview.bar}
          >
            <span className="flex items-baseline gap-2 min-w-0 text-xs">
              <span className="font-medium text-foreground/80 shrink-0" style={preview.header ? { color: preview.header } : undefined}>
                2 Hidden Events:
              </span>
              <span className="text-muted-foreground truncate" style={preview.detail ? { color: preview.detail } : undefined}>
                Ran 2 commands.
              </span>
            </span>
            <ChevronsUpDown
              className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0"
              style={preview.detail ? { color: preview.detail } : undefined}
              aria-hidden="true"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ColorField
          name="Background"
          value={value.background}
          onChange={(background) => { onChange({ ...value, background }); }}
        />
        <ColorField
          name="Border"
          value={value.border}
          onChange={(border) => { onChange({ ...value, border }); }}
        />
        <ColorField
          name="Header text"
          unsetLabel="automatic"
          value={value.headerText}
          onChange={(headerText) => { onChange({ ...value, headerText }); }}
        />
        <ColorField
          name="Detail text"
          unsetLabel="automatic"
          value={value.detailText}
          onChange={(detailText) => { onChange({ ...value, detailText }); }}
        />
      </div>
      <p className="text-caption text-muted-foreground">
        Automatic text turns light or dark to stay readable on the background you pick.
      </p>
    </div>
  );
};

const ColorField: React.FC<{
  name: string;
  /** What an unset value means here — the theme's look, or automatic text. */
  unsetLabel?: string;
  value: string | null;
  onChange: (next: string | null) => void;
}> = ({ name, unsetLabel = "theme default", value, onChange }) => {
  const lower = name.toLowerCase();
  // Local text so a half-typed hex is not bounced; only a valid one commits.
  const [text, setText] = useState(value ?? "");
  useEffect(() => { setText(value ?? ""); }, [value]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>{name} colour</Label>
        {value !== null ? (
          <button
            type="button"
            onClick={() => { onChange(null); }}
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
            aria-label={`Reset ${lower} colour`}
          >
            <Undo2 className="h-3 w-3" />
            {unsetLabel}
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
          aria-label={`${name} colour picker`}
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
          aria-label={`${name} colour hex`}
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

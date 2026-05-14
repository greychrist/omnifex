import React from "react";
import { Lock } from "lucide-react";
import type {
  MessageKindConfig,
  Palette,
  IconName,
  IconSize,
  Typography,
} from "@/lib/messageRenderingConfig";
import { ALLOWED_ICONS, isHexColor } from "@/lib/messageRenderingConfig";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IconRenderer } from "./iconMap";
import { cn } from "@/lib/utils";

interface KindEditorProps {
  kind: MessageKindConfig;
  /** Kept on the props for backwards compatibility with the global palette
   *  retinting flow. Resolved into a `swatch` for the picker's initial
   *  value when the kind still references a palette name (legacy data). */
  palette: Palette;
  /** Global icon defaults — used to label "Use default (X)" placeholders so
   *  the user knows what the kind will inherit when an override is unset. */
  typography: Typography;
  onChange: (patch: Partial<MessageKindConfig>) => void;
  onResetKind: () => void;
}

const ICON_SIZE_OPTIONS: { value: IconSize; label: string }[] = [
  { value: "xs", label: "Extra small" },
  { value: "sm", label: "Small" },
  { value: "base", label: "Base" },
  { value: "lg", label: "Large" },
  { value: "xl", label: "Extra large" },
];

const SENTINEL_DEFAULT = "__default__";

/**
 * Resolve `kind.accentColor` (palette name OR hex) to a `#rrggbb` for the
 * native `<input type="color">`, which only accepts that exact form.
 * Falls back to a neutral grey for unknown values.
 */
function resolveAccentHex(accentColor: string, palette: Palette): string {
  if (isHexColor(accentColor)) {
    // Normalise `#rgb` and `#rrggbbaa` down to `#rrggbb` so the native
    // picker doesn't reject them. Alpha is dropped — the picker has no
    // alpha lane; alpha is re-derived from `accentStyleFromEntry`.
    if (accentColor.length === 4) {
      const r = accentColor[1];
      const g = accentColor[2];
      const b = accentColor[3];
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return accentColor.slice(0, 7).toLowerCase();
  }
  const entry = palette[accentColor as keyof typeof palette];
  return entry?.swatch ?? "#888888";
}

export const KindEditor: React.FC<KindEditorProps> = ({
  kind,
  palette,
  typography,
  onChange,
  onResetKind,
}) => {
  const effectiveBordered = kind.iconBordered ?? typography.icon.bordered;
  const effectiveBgOpacity = kind.iconBgOpacity ?? typography.icon.bgOpacity;
  const overrideBgOpacity = kind.iconBgOpacity !== undefined;

  const accentHex = resolveAccentHex(kind.accentColor, palette);

  const sizeLabel = (id: IconSize) =>
    ICON_SIZE_OPTIONS.find((o) => o.value === id)?.label ?? id;

  return (
    <div className="space-y-6">
      <header className="pb-2 border-b border-border">
        <h4 className="text-heading-4">{kind.label}</h4>
        <p className="text-caption text-muted-foreground mt-1">{kind.description}</p>
        <p className="text-[10px] text-muted-foreground/70 mt-1 font-mono">
          id: {kind.id} · origin: {kind.origin}
          {kind.widget && ` · widget: ${kind.widget}`}
        </p>
      </header>

      {/* 1. Hide in compact mode */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5 flex-1">
          <Label className="flex items-center gap-1.5">
            Hide in compact mode
            {kind.compactBoundaryLocked && (
              <Lock className="h-3 w-3 text-muted-foreground" />
            )}
          </Label>
          <p className="text-caption text-muted-foreground">
            {kind.compactBoundaryLocked
              ? "Always visible — turn boundary."
              : "When hidden, collapses into the nearest expander in compact mode."}
          </p>
        </div>
        <Switch
          checked={kind.hiddenInCompact}
          disabled={kind.compactBoundaryLocked}
          onCheckedChange={(checked) => { onChange({ hiddenInCompact: checked }); }}
        />
      </div>

      {/* 2. Header label + accent colour — side-by-side. The label is the
            user-facing title that lands in the card's KindHeader; the
            colour picker is a native <input type="color"> backed by a
            hex text field so users can type values too. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <div className="space-y-2">
          <Label htmlFor="header-label">Header label</Label>
          <Input
            id="header-label"
            value={kind.headerLabel ?? ""}
            placeholder="(no header)"
            onChange={(e) =>
              { onChange({
                headerLabel: e.target.value === "" ? null : e.target.value,
              }); }
            }
          />
          <p className="text-caption text-muted-foreground">
            Leave blank to hide the header bar.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="accent-color">Accent colour</Label>
          <div className="flex items-center gap-2">
            {/* Native colour picker — clicking opens the OS picker. The
                hex value is what gets written; alpha/border tinting is
                derived from it by `accentStyleFromEntry`. */}
            <input
              id="accent-color"
              type="color"
              value={accentHex}
              onChange={(e) => { onChange({ accentColor: e.target.value }); }}
              className={cn(
                "h-9 w-12 cursor-pointer rounded-md border border-border",
                "bg-background p-1",
                "focus:outline-none focus:ring-1 focus:ring-ring",
              )}
              aria-label="Accent colour picker"
            />
            <Input
              value={accentHex}
              onChange={(e) => {
                const v = e.target.value.trim();
                // Accept partial typing without bouncing the user — only
                // commit when the value looks like a valid hex. Anything
                // else is held in the controlled input via the picker's
                // value above.
                if (isHexColor(v)) {
                  onChange({ accentColor: v.toLowerCase() });
                }
              }}
              className="font-mono text-xs h-9 w-24"
              aria-label="Accent colour hex"
            />
          </div>
          <p className="text-caption text-muted-foreground">
            Drives the card border and a subtle bg tint.
          </p>
        </div>
      </div>

      {/* 3. Icon — dropdown with previews */}
      <div className="space-y-2">
        <Label>Icon</Label>
        <Select
          value={kind.icon}
          onValueChange={(v) => { onChange({ icon: v as IconName }); }}
        >
          <SelectTrigger>
            <SelectValue>
              <div className="flex items-center gap-2">
                {kind.icon === "none" ? (
                  <span className="text-muted-foreground text-xs">—</span>
                ) : (
                  <IconRenderer name={kind.icon} className="h-4 w-4" />
                )}
                <span>{kind.icon}</span>
              </div>
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="max-h-80">
            {(ALLOWED_ICONS as readonly IconName[]).map((name) => (
              <SelectItem key={name} value={name}>
                <div className="flex items-center gap-2">
                  {name === "none" ? (
                    <span className="text-muted-foreground text-xs">—</span>
                  ) : (
                    <IconRenderer name={name} className="h-4 w-4" />
                  )}
                  <span>{name}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 4. Icon chrome — per-kind overrides for the icon's size, border,
            and background opacity. Inherits from the global Typography →
            Card icon defaults when unset. */}
      <div className="space-y-3 pt-3 border-t border-border">
        <div>
          <Label>Icon chrome (per-kind overrides)</Label>
          <p className="text-caption text-muted-foreground mt-1">
            Defaults come from <em>Typography → Card icon</em>. Override here to
            tweak just this kind.
          </p>
        </div>

        {/* Size override */}
        <div className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-3">
          <Label className="text-caption">Size</Label>
          <Select
            value={kind.iconSize ?? SENTINEL_DEFAULT}
            onValueChange={(v) =>
              { onChange({ iconSize: v === SENTINEL_DEFAULT ? undefined : (v as IconSize) }); }
            }
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={SENTINEL_DEFAULT}>
                Use default ({sizeLabel(typography.icon.size)})
              </SelectItem>
              {ICON_SIZE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Bordered override */}
        <div className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-3">
          <Label className="text-caption">Chip border</Label>
          <Select
            value={
              kind.iconBordered === undefined
                ? SENTINEL_DEFAULT
                : kind.iconBordered
                  ? "on"
                  : "off"
            }
            onValueChange={(v) =>
              { onChange({
                iconBordered:
                  v === SENTINEL_DEFAULT ? undefined : v === "on",
              }); }
            }
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={SENTINEL_DEFAULT}>
                Use default ({typography.icon.bordered ? "Bordered" : "No border"})
              </SelectItem>
              <SelectItem value="on">Bordered</SelectItem>
              <SelectItem value="off">No border</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* BgOpacity override */}
        <div className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-3">
          <Label className="text-caption">Background opacity</Label>
          <div className={cn("flex items-center gap-2", !effectiveBordered && "opacity-50")}>
            <Switch
              id={`${kind.id}-bg-override`}
              checked={overrideBgOpacity}
              disabled={!effectiveBordered}
              onCheckedChange={(v) =>
                { onChange({
                  iconBgOpacity: v ? typography.icon.bgOpacity : undefined,
                }); }
              }
            />
            <Label
              htmlFor={`${kind.id}-bg-override`}
              className="text-[10px] text-muted-foreground cursor-pointer w-12 shrink-0"
            >
              {overrideBgOpacity ? "Override" : "Default"}
            </Label>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={effectiveBgOpacity}
              disabled={!effectiveBordered || !overrideBgOpacity}
              onChange={(e) =>
                { onChange({ iconBgOpacity: parseInt(e.target.value, 10) }); }
              }
              className="flex-1 cursor-pointer disabled:cursor-not-allowed accent-foreground"
            />
            <span className="font-mono text-[10px] text-muted-foreground w-10 text-right">
              {effectiveBgOpacity}%
            </span>
          </div>
        </div>
      </div>

      <div className="pt-2 border-t border-border flex items-center justify-between">
        <p className="text-caption text-muted-foreground">
          Alignment and widget are not editable in v1.
        </p>
        <button
          type="button"
          onClick={onResetKind}
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          Reset this kind to default
        </button>
      </div>
    </div>
  );
};

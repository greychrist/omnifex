import React from "react";
import { Lock, Undo2 } from "lucide-react";
import type {
  KindStyle,
  Palette,
  IconName,
  Presentation,
  BorderStyle,
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
import { Popover } from "@/components/ui/popover";
import { ChevronDown } from "lucide-react";
import { IconRenderer } from "./iconMap";
import { chipBorderValue, chipBorderPatch, type ChipBorderValue } from "./iconChrome";
import { cn } from "@/lib/utils";

// Sort once at module load. "none" pinned at the top; the rest alphabetical
// (case-insensitive) so the picker grid is browseable.
const SORTED_ICONS: readonly IconName[] = (() => {
  const rest = (ALLOWED_ICONS as readonly IconName[]).filter((n) => n !== "none");
  rest.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return ((ALLOWED_ICONS as readonly IconName[]).includes("none" as IconName)
    ? (["none" as IconName, ...rest])
    : rest);
})();

export type KindEditorMode = "category" | "kind";

interface KindEditorProps {
  mode: KindEditorMode;
  /** Category name (category mode) or kind id (override mode). Informational
   *  header + per-kind icon-chrome key. */
  kindId: string;
  label: string;
  description?: string;
  /** The fully-resolved style to render controls from. In category mode this
   *  is the CategoryStyle itself; in override mode it is the category default
   *  ⊕ the override (so set fields show their override value and unset fields
   *  show the inherited value). */
  style: KindStyle;
  /** Override mode only: the raw override patch — which fields are actually
   *  set on the override (vs. inherited from the category). */
  override?: Partial<KindStyle>;
  /** Override mode only: the category this kind inherits from, for the
   *  "inheriting from {Category}" hint and placeholder text. */
  inheritedCategoryLabel?: string;
  /** Kept on the props for backwards compatibility with the global palette
   *  retinting flow. Resolved into a `swatch` for the picker's initial
   *  value when the kind still references a palette name (legacy data). */
  palette: Palette;
  /** Global icon defaults — used to label "Use default (X)" placeholders so
   *  the user knows what the kind will inherit when an override is unset. */
  typography: Typography;
  /** Persist a style field. In override mode this writes only that field into
   *  the override. */
  onChange: (patch: Partial<KindStyle>) => void;
  /** Override mode only: clear a field back to its inherited category value. */
  onClearField?: (field: keyof KindStyle) => void;
  /** Category mode: reset the category to its factory default. Override mode:
   *  remove the override entirely. */
  onReset: () => void;
}

const PRESENTATION_OPTIONS: { value: Presentation; label: string }[] = [
  { value: "card", label: "Card" },
  { value: "side-line", label: "Side line" },
  { value: "collapsible", label: "Collapsible" },
];

const BORDER_OPTIONS: { value: BorderStyle; label: string }[] = [
  { value: "solid", label: "Solid" },
  { value: "dashed", label: "Dashed" },
];

/**
 * Resolve an accentColor (palette name OR hex) to a `#rrggbb` for the
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

/**
 * Popover-based icon picker with a 6-column grid. Sorted alphabetically with
 * "none" pinned at the top.
 */
const IconPicker: React.FC<{ value: IconName; onChange: (v: IconName) => void }> = ({
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

/**
 * Small "inheriting from {Category}" affordance shown next to override fields.
 * When the field is overridden, offers a revert button; when it's inherited,
 * states so in muted text so the user knows the value comes from the category.
 */
const InheritHint: React.FC<{
  overridden: boolean;
  categoryLabel: string;
  onClear: () => void;
}> = ({ overridden, categoryLabel, onClear }) => {
  if (overridden) {
    return (
      <button
        type="button"
        onClick={onClear}
        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
        title={`Revert to the ${categoryLabel} category value`}
      >
        <Undo2 className="h-3 w-3" />
        revert to inherited
      </button>
    );
  }
  return (
    <span className="text-[10px] text-muted-foreground/70 italic">
      inherited from {categoryLabel}
    </span>
  );
};

export const KindEditor: React.FC<KindEditorProps> = ({
  mode,
  kindId,
  label,
  description,
  style,
  override,
  inheritedCategoryLabel,
  palette,
  typography,
  onChange,
  onClearField,
  onReset,
}) => {
  const isKind = mode === "kind";
  const ov = override ?? {};
  const catLabel = inheritedCategoryLabel ?? "category";

  const has = (field: keyof KindStyle): boolean =>
    isKind ? Object.prototype.hasOwnProperty.call(ov, field) : true;

  const clear = (field: keyof KindStyle) => {
    onClearField?.(field);
  };

  const effectiveBordered = style.iconBordered ?? typography.icon.bordered;
  const effectiveBgOpacity = style.iconBgOpacity ?? typography.icon.bgOpacity;
  const overrideBgOpacity = has("iconBgOpacity");

  const accentHex = resolveAccentHex(style.accentColor, palette);

  return (
    <div className="space-y-6" data-testid="kind-editor">
      <header className="pb-2 border-b border-border">
        <h4 className="text-heading-4">{label}</h4>
        {description && (
          <p className="text-caption text-muted-foreground mt-1">{description}</p>
        )}
        <p className="text-[10px] text-muted-foreground/70 mt-1 font-mono">
          {isKind ? `kind: ${kindId}` : `category: ${kindId}`}
          {style.widget && ` · widget: ${style.widget}`}
        </p>
        {isKind && (
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">
            Unset fields inherit from the <strong>{catLabel}</strong> category.
          </p>
        )}
      </header>

      {/* 1. Hide in compact mode */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5 flex-1">
          <Label className="flex items-center gap-1.5">
            Hide in compact mode
            {style.compactBoundaryLocked && (
              <Lock className="h-3 w-3 text-muted-foreground" />
            )}
          </Label>
          <p className="text-caption text-muted-foreground">
            {style.compactBoundaryLocked
              ? "Always visible — turn boundary."
              : "When hidden, collapses into the nearest expander in compact mode."}
          </p>
          {isKind && (
            <InheritHint
              overridden={has("hiddenInCompact")}
              categoryLabel={catLabel}
              onClear={() => { clear("hiddenInCompact"); }}
            />
          )}
        </div>
        <Switch
          checked={style.hiddenInCompact}
          disabled={style.compactBoundaryLocked}
          onCheckedChange={(checked) => { onChange({ hiddenInCompact: checked }); }}
        />
      </div>

      {/* 2. Presentation + Border dropdowns */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label>Presentation</Label>
            {isKind && (
              <InheritHint
                overridden={has("presentation")}
                categoryLabel={catLabel}
                onClear={() => { clear("presentation"); }}
              />
            )}
          </div>
          <Select
            value={style.presentation}
            onValueChange={(v) => { onChange({ presentation: v as Presentation }); }}
          >
            <SelectTrigger
              aria-label="Presentation"
              className={cn(isKind && !has("presentation") && "text-muted-foreground")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESENTATION_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label>Border</Label>
            {isKind && (
              <InheritHint
                overridden={has("borderStyle")}
                categoryLabel={catLabel}
                onClear={() => { clear("borderStyle"); }}
              />
            )}
          </div>
          <Select
            value={style.borderStyle}
            onValueChange={(v) => { onChange({ borderStyle: v as BorderStyle }); }}
          >
            <SelectTrigger
              aria-label="Border"
              className={cn(isKind && !has("borderStyle") && "text-muted-foreground")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BORDER_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 3. Alignment */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Alignment</Label>
          {isKind && (
            <InheritHint
              overridden={has("alignment")}
              categoryLabel={catLabel}
              onClear={() => { clear("alignment"); }}
            />
          )}
        </div>
        <Select
          value={style.alignment}
          onValueChange={(v) => { onChange({ alignment: v as KindStyle["alignment"] }); }}
        >
          <SelectTrigger
            aria-label="Alignment"
            className={cn(isKind && !has("alignment") && "text-muted-foreground")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left">Left</SelectItem>
            <SelectItem value="right">Right</SelectItem>
            <SelectItem value="full">Full width</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* 4. Header label — only shown in card / collapsible presentation.
            Side-line messages don't have a visible header bar. */}
      {style.presentation !== 'side-line' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="header-label">Header label</Label>
            {isKind && (
              <InheritHint
                overridden={has("headerLabel")}
                categoryLabel={catLabel}
                onClear={() => { clear("headerLabel"); }}
              />
            )}
          </div>
          <Input
            id="header-label"
            value={style.headerLabel ?? ""}
            placeholder={
              isKind && !has("headerLabel")
                ? `(inherited: ${style.headerLabel ?? "no header"})`
                : "(no header)"
            }
            aria-label="Header label"
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
      )}

      {/* 5 + 6. Accent colour + Icon — side by side to save vertical space. */}
      <div className="grid grid-cols-2 gap-3 items-start">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="accent-color">Accent colour</Label>
            {isKind && (
              <InheritHint
                overridden={has("accentColor")}
                categoryLabel={catLabel}
                onClear={() => { clear("accentColor"); }}
              />
            )}
          </div>
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
              className="font-mono text-xs h-9 min-w-0 flex-1"
              aria-label="Accent colour hex"
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label>Icon</Label>
            {isKind && (
              <InheritHint
                overridden={has("icon")}
                categoryLabel={catLabel}
                onClear={() => { clear("icon"); }}
              />
            )}
          </div>
          <IconPicker value={style.icon} onChange={(v) => { onChange({ icon: v }); }} />
        </div>
      </div>

      {/* 7. Icon chrome — per-kind overrides for the icon's border and
            background opacity. Inherits from the global Typography → Card
            icon defaults when unset. */}
      <div className="space-y-3 pt-3 border-t border-border">
        <div>
          <Label>Icon chrome (per-kind overrides)</Label>
          <p className="text-caption text-muted-foreground mt-1">
            Defaults come from <em>Typography → Card icon</em>. Override here to
            tweak just this kind.
          </p>
        </div>

        {/* Bordered override */}
        <div className="grid grid-cols-[10rem_minmax(0,1fr)] items-center gap-3">
          <Label className="text-caption">Chip border</Label>
          <Select
            value={chipBorderValue(style.iconBordered)}
            onValueChange={(v) => { onChange(chipBorderPatch(v as ChipBorderValue)); }}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="default">
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
              id={`${kindId}-bg-override`}
              checked={overrideBgOpacity}
              disabled={!effectiveBordered}
              onCheckedChange={(v) => {
                if (v) onChange({ iconBgOpacity: typography.icon.bgOpacity });
                else if (isKind) clear("iconBgOpacity");
                else onChange({ iconBgOpacity: undefined });
              }}
            />
            <Label
              htmlFor={`${kindId}-bg-override`}
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

      {/* 8. Show raw payload — diagnostic toggle. */}
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            aria-label="Show raw payload"
            checked={style.showRawPayload ?? false}
            onChange={(e) => { onChange({ showRawPayload: e.target.checked }); }}
            className="h-4 w-4 rounded border border-input accent-foreground cursor-pointer"
          />
          <span className="text-xs">Show raw payload</span>
        </label>
        {isKind && (
          <InheritHint
            overridden={has("showRawPayload")}
            categoryLabel={catLabel}
            onClear={() => { clear("showRawPayload"); }}
          />
        )}
      </div>

      <div className="pt-2 border-t border-border flex items-center justify-between">
        <p className="text-caption text-muted-foreground">
          Widget type is informational only.
        </p>
        <button
          type="button"
          onClick={onReset}
          aria-label={isKind ? "Reset to default" : "Reset category to default"}
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          {isKind ? "Reset to default" : "Reset category to default"}
        </button>
      </div>
    </div>
  );
};

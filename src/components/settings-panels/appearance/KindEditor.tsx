import React from "react";
import { Lock, Undo2 } from "lucide-react";
import type {
  CollapseRule,
  KindStyle,
  Presentation,
  BorderStyle,
  Typography,
  Visibility,
} from "@/lib/messageRenderingConfig";
import { isHexColor } from "@/lib/messageRenderingConfig";
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
import { IconPicker } from "./IconPicker";
import { EditorRow as Row } from "./EditorRow";
import { chipBorderValue, chipBorderPatch, type ChipBorderValue } from "./iconChrome";
import { cn } from "@/lib/utils";

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
  /** Global icon defaults — used to label "Use default (X)" placeholders so
   *  the user knows what the kind will inherit when an override is unset. */
  typography: Typography;
  /** Persist a style field. In override mode this writes only that field into
   *  the override. */
  onChange: (patch: Partial<KindStyle>) => void;
  /** Override mode only: clear a field back to its inherited category value. */
  onClearField?: (field: keyof KindStyle) => void;
  /** Override mode only: the kind's registry collapse rule. The Repeats
   *  control appears only when there is one. */
  collapseRule?: CollapseRule;
  /** Category mode: reset the category to its factory default. Override mode:
   *  remove the override entirely. */
  onReset: () => void;
}

const VISIBILITY_OPTIONS: { value: Visibility; label: string; hint: string }[] = [
  { value: "always", label: "Always", hint: "Shown in both compact and verbose mode." },
  { value: "verbose", label: "Verbose only", hint: "Collapses into the nearest expander in compact mode." },
  { value: "never", label: "Never", hint: "Not shown in either mode." },
];

const REPEATS_HINT: Record<CollapseRule["mode"], string> = {
  latestInRun: "Keeps the last of each run — the one carrying the latest snapshot.",
  onChange: "Keeps a row only when its value changes.",
};

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
 * An accentColor as the `#rrggbb` the native `<input type="color">` requires.
 * Falls back to a neutral grey for anything that is not a hex.
 */
function resolveAccentHex(accentColor: string): string {
  if (isHexColor(accentColor)) {
    // Normalise `#rgb` and `#rrggbbaa` down to `#rrggbb` so the native
    // picker doesn't reject them. Alpha is dropped — the picker has no
    // alpha lane; the border alpha comes from the card border opacity.
    if (accentColor.length === 4) {
      const r = accentColor[1];
      const g = accentColor[2];
      const b = accentColor[3];
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return accentColor.slice(0, 7).toLowerCase();
  }
  return "#888888";
}


/**
 * The one inherit marker a row carries. Overridden: a revert button that puts
 * every overridden field in the row back to the category's value. Otherwise a
 * muted "inherited", with the category named in its tooltip.
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
        revert
      </button>
    );
  }
  return (
    <span className="text-[10px] text-muted-foreground/70 italic" title={`Inherited from ${categoryLabel}`}>
      inherited
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
  typography,
  onChange,
  onClearField,
  collapseRule,
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

  const accentHex = resolveAccentHex(style.accentColor);

  /** The row's inherit marker, over every field it edits (kind mode only). */
  const rowHint = (fields: (keyof KindStyle)[]) => {
    if (!isKind) return null;
    const overridden = fields.filter(has);
    return (
      <InheritHint
        overridden={overridden.length > 0}
        categoryLabel={catLabel}
        onClear={() => { for (const f of overridden) clear(f); }}
      />
    );
  };

  const segment = (checked: boolean) =>
    cn(
      "rounded px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
      checked ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-muted/40",
    );

  const inherited = (field: keyof KindStyle) => isKind && !has(field) && "text-muted-foreground";

  return (
    <div className="space-y-3" data-testid="kind-editor">
      <header className="pb-2 border-b border-border">
        <div className="flex items-baseline justify-between gap-3">
          <h4 className="text-heading-4">{label}</h4>
          <span className="text-[10px] text-muted-foreground/70 font-mono truncate">
            {isKind ? `kind: ${kindId}` : `category: ${kindId}`}
            {style.widget && ` · widget: ${style.widget}`}
          </span>
        </div>
        {description && (
          <p className="text-caption text-muted-foreground mt-0.5">{description}</p>
        )}
        {isKind && (
          <p className="text-[10px] text-muted-foreground/70 mt-0.5">
            Unset fields inherit from the <strong>{catLabel}</strong> category.
          </p>
        )}
      </header>

      <Row
        name="Visibility"
        label={
          <span className="flex items-center gap-1.5">
            Visibility
            {style.compactBoundaryLocked && <Lock className="h-3 w-3 text-muted-foreground" />}
          </span>
        }
        hint={rowHint(["visibility"])}
      >
        <div
          role="radiogroup"
          aria-label="Visibility"
          className="inline-flex shrink-0 gap-0.5 rounded-md border border-input p-0.5"
        >
          {VISIBILITY_OPTIONS.map((o) => {
            const checked = style.visibility === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={style.compactBoundaryLocked}
                onClick={() => { onChange({ visibility: o.value }); }}
                className={segment(checked)}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <span className="text-[11px] text-muted-foreground truncate">
          {style.compactBoundaryLocked
            ? "Always visible — turn boundary."
            : VISIBILITY_OPTIONS.find((o) => o.value === style.visibility)?.hint}
        </span>
      </Row>

      {/* Only kinds whose registry entry declares a collapse rule. */}
      {isKind && collapseRule && (
        <Row name="Repeats" hint={rowHint(["collapseRepeats"])}>
          <div
            role="radiogroup"
            aria-label="Repeats"
            className="inline-flex shrink-0 gap-0.5 rounded-md border border-input p-0.5"
          >
            {([
              { value: true, label: "Collapse" },
              { value: false, label: "Show all" },
            ] as const).map((o) => {
              const checked = (style.collapseRepeats ?? true) === o.value;
              return (
                <button
                  key={o.label}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => { onChange({ collapseRepeats: o.value }); }}
                  className={segment(checked)}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          <span className="text-[11px] text-muted-foreground truncate">
            {(style.collapseRepeats ?? true) ? REPEATS_HINT[collapseRule.mode] : "Every repeat gets its own row."}
          </span>
        </Row>
      )}

      <Row name="Layout" hint={rowHint(["presentation", "borderStyle", "alignment"])}>
        <Select
          value={style.presentation}
          onValueChange={(v) => { onChange({ presentation: v as Presentation }); }}
        >
          <SelectTrigger aria-label="Presentation" className={cn("flex-1", inherited("presentation"))}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRESENTATION_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={style.borderStyle}
          onValueChange={(v) => { onChange({ borderStyle: v as BorderStyle }); }}
        >
          <SelectTrigger aria-label="Border" className={cn("flex-1", inherited("borderStyle"))}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BORDER_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label} border</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={style.alignment}
          onValueChange={(v) => { onChange({ alignment: v as KindStyle["alignment"] }); }}
        >
          <SelectTrigger aria-label="Alignment" className={cn("flex-1", inherited("alignment"))}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left">Left aligned</SelectItem>
            <SelectItem value="right">Right aligned</SelectItem>
            <SelectItem value="full">Full width</SelectItem>
            <SelectItem value="narrow-center">Narrow centered</SelectItem>
          </SelectContent>
        </Select>
      </Row>

      {/* Side-line rows have no header bar to label. */}
      {style.presentation !== 'side-line' && (
        <Row name="Header label" label="Header" hint={rowHint(["headerLabel"])}>
          <Input
            id="header-label"
            value={style.headerLabel ?? ""}
            placeholder={
              isKind && !has("headerLabel")
                ? `(inherited: ${style.headerLabel ?? "no header"})`
                : "Blank hides the header bar"
            }
            title="Leave blank to hide the header bar."
            aria-label="Header label"
            onChange={(e) =>
              { onChange({
                headerLabel: e.target.value === "" ? null : e.target.value,
              }); }
            }
          />
        </Row>
      )}

      <Row name="Colour and icon" label="Colour, icon" hint={rowHint(["accentColor", "icon"])}>
        {/* Native colour picker — clicking opens the OS picker. The hex value
            is what gets written; the border and background tints are derived
            from it by `accentStyleFor`. */}
        <input
          id="accent-color"
          type="color"
          value={accentHex}
          onChange={(e) => { onChange({ accentColor: e.target.value }); }}
          className={cn(
            "h-9 w-11 shrink-0 cursor-pointer rounded-md border border-border",
            "bg-background p-1",
            "focus:outline-none focus:ring-1 focus:ring-ring",
          )}
          aria-label="Accent colour picker"
        />
        <Input
          value={accentHex}
          onChange={(e) => {
            const v = e.target.value.trim();
            // Accept partial typing without bouncing the user — only commit
            // when the value looks like a valid hex.
            if (isHexColor(v)) {
              onChange({ accentColor: v.toLowerCase() });
            }
          }}
          className="font-mono text-xs h-9 w-24 shrink-0"
          aria-label="Accent colour hex"
        />
        <div className="min-w-0 flex-1">
          <IconPicker value={style.icon} onChange={(v) => { onChange({ icon: v }); }} />
        </div>
      </Row>

      {/* Per-kind overrides of Typography › Card icon. */}
      <Row name="Icon chip">
        <Select
          value={chipBorderValue(style.iconBordered)}
          onValueChange={(v) => { onChange(chipBorderPatch(v as ChipBorderValue)); }}
        >
          <SelectTrigger aria-label="Chip border" className="w-48 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">
              Default ({typography.icon.bordered ? "bordered" : "no border"})
            </SelectItem>
            <SelectItem value="on">Bordered</SelectItem>
            <SelectItem value="off">No border</SelectItem>
          </SelectContent>
        </Select>
        <div className={cn("flex min-w-0 flex-1 items-center gap-2", !effectiveBordered && "opacity-50")}>
          <Switch
            id={`${kindId}-bg-override`}
            checked={overrideBgOpacity}
            disabled={!effectiveBordered}
            aria-label="Override icon background opacity"
            onCheckedChange={(v) => {
              if (v) onChange({ iconBgOpacity: typography.icon.bgOpacity });
              else if (isKind) clear("iconBgOpacity");
              else onChange({ iconBgOpacity: undefined });
            }}
          />
          <Label
            htmlFor={`${kindId}-bg-override`}
            className="text-[10px] text-muted-foreground cursor-pointer shrink-0"
          >
            bg
          </Label>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={effectiveBgOpacity}
            disabled={!effectiveBordered || !overrideBgOpacity}
            aria-label="Icon background opacity"
            onChange={(e) =>
              { onChange({ iconBgOpacity: parseInt(e.target.value, 10) }); }
            }
            className="min-w-0 flex-1 cursor-pointer disabled:cursor-not-allowed accent-foreground"
          />
          <span className="font-mono text-[10px] text-muted-foreground w-9 text-right">
            {effectiveBgOpacity}%
          </span>
        </div>
      </Row>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            aria-label="Show raw payload"
            checked={style.showRawPayload ?? false}
            onChange={(e) => { onChange({ showRawPayload: e.target.checked }); }}
            className="h-4 w-4 rounded border border-input accent-foreground cursor-pointer"
          />
          <span className="text-xs">Show raw payload</span>
          {rowHint(["showRawPayload"])}
        </label>
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

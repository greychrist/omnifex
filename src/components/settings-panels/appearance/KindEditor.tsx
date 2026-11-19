import React from "react";
import { Lock, Undo2 } from "lucide-react";
import type { KindStyle } from "@/lib/messageRenderingConfig";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { IconPicker } from "./IconPicker";
import { ColorField } from "./ColorField";

export type KindEditorMode = "category" | "kind";

interface KindEditorProps {
  mode: KindEditorMode;
  label: string;
  description?: string;
  /** The resolved style the controls show: a category's own, or a kind's
   *  category ⊕ registry default ⊕ user patch. */
  style: KindStyle;
  /** Kind mode: the fields the user set on this kind, vs. inherited. */
  override?: Partial<KindStyle>;
  /** Kind mode: the category it inherits from, for the reset labels. */
  inheritedCategoryLabel?: string;
  onChange: (patch: Partial<KindStyle>) => void;
  /** Put a field back: a kind inherits again, a category takes its default. */
  onClearField: (field: keyof KindStyle) => void;
  onReset: () => void;
}

/**
 * Settings › Chats › Messages, one kind or category: its icon and color (the
 * Modern line it is drawn as wears both), and whether Standard shows it.
 * Expanded draws every record whatever this says.
 */
export const KindEditor: React.FC<KindEditorProps> = ({
  mode,
  label,
  description,
  style,
  override,
  inheritedCategoryLabel,
  onChange,
  onClearField,
  onReset,
}) => {
  const isKind = mode === "kind";
  const inherited = (field: keyof KindStyle) => isKind && override?.[field] === undefined;
  const from = inheritedCategoryLabel ?? "category";

  return (
    <section role="region" aria-label={`${label} settings`} className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium">{label}</h4>
          {description && <p className="text-caption text-muted-foreground mt-0.5">{description}</p>}
        </div>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          <Undo2 className="h-3 w-3" />
          {isKind ? "Reset kind" : "Reset category"}
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Icon</Label>
          {isKind && !inherited("icon") && (
            <button
              type="button"
              onClick={() => { onClearField("icon"); }}
              className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              Use {from}'s
            </button>
          )}
        </div>
        <IconPicker value={style.icon} onChange={(icon) => { onChange({ icon }); }} />
      </div>

      <ColorField
        name={label}
        title="Color"
        unsetLabel={isKind ? `${from}'s color` : "default"}
        value={isKind ? (override?.accentColor ?? null) : style.accentColor}
        onChange={(next) => {
          if (next === null) onClearField("accentColor");
          else onChange({ accentColor: next });
        }}
      />

      <div className="flex items-center justify-between gap-3">
        <div>
          <Label htmlFor={`standard-${label}`}>Show in Standard</Label>
          <p className="text-caption text-muted-foreground mt-0.5">
            {style.alwaysShown
              ? "A turn boundary: always shown."
              : isKind && inherited("standard")
                ? `Following ${from}. Expanded always shows it.`
                : "Expanded always shows it."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {style.alwaysShown && <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
          <Switch
            id={`standard-${label}`}
            aria-label="Show in Standard"
            checked={style.alwaysShown || style.standard}
            disabled={style.alwaysShown}
            onCheckedChange={(standard) => { onChange({ standard }); }}
          />
        </div>
      </div>
    </section>
  );
};

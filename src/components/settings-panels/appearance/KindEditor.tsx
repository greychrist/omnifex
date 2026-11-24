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
  style: KindStyle;
  override?: Partial<KindStyle>;
  inheritedCategoryLabel?: string;
  /** An unset field falls back to this registry default, not the category. */
  builtIn?: Partial<KindStyle>;
  onChange: (patch: Partial<KindStyle>) => void;
  onClearField: (field: keyof KindStyle) => void;
  onReset: () => void;
  offersStandard?: boolean;
  offersColor?: boolean;
}

export const KindEditor: React.FC<KindEditorProps> = ({
  mode,
  label,
  description,
  style,
  override,
  inheritedCategoryLabel,
  builtIn,
  onChange,
  onClearField,
  onReset,
  offersStandard = true,
  offersColor = true,
}) => {
  const isKind = mode === "kind";
  const inherited = (field: keyof KindStyle) => isKind && override?.[field] === undefined;
  const from = inheritedCategoryLabel ?? "category";
  const hasDefault = (field: keyof KindStyle) => builtIn?.[field] !== undefined;

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
              {hasDefault("icon") ? "Use default" : `Use ${from}'s`}
            </button>
          )}
        </div>
        <IconPicker value={style.icon} onChange={(icon) => { onChange({ icon }); }} />
      </div>

      {offersColor && (
      <ColorField
        name={label}
        title="Color"
        unsetLabel={isKind && !hasDefault("accentColor") ? `${from}'s color` : "default"}
        value={isKind ? (override?.accentColor ?? null) : style.accentColor}
        fallback={isKind ? style.accentColor : undefined}
        onChange={(next) => {
          if (next === null) onClearField("accentColor");
          else onChange({ accentColor: next });
        }}
      />
      )}

      {offersStandard && (
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label htmlFor={`standard-${label}`}>Show in Standard</Label>
          <p className="text-caption text-muted-foreground mt-0.5">
            {style.alwaysShown
              ? "A turn boundary: always shown."
              : isKind && inherited("standard")
                ? hasDefault("standard")
                  ? `${style.standard ? "Shown" : "Hidden"} by default. Expanded always shows it.`
                  : `Following ${from}. Expanded always shows it.`
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
      )}
    </section>
  );
};

import React from "react";
import { Undo2 } from "lucide-react";
import { DEFAULT_MODERN, type IconName, type ModernStepKind } from "@/lib/messageRenderingConfig";
import { Label } from "@/components/ui/label";
import { IconPicker } from "./IconPicker";
import { ColorField } from "./ColorField";
import { STEP_LABELS } from "./stepLabels";

/**
 * Settings › Chats › Messages, one kind of timeline step: its icon and color.
 * A color tints the step's icon and the line beside it when opened; a failed
 * step stays red. Steps are always shown, so there is no Show in Standard.
 */
export const StepEditor: React.FC<{
  kind: ModernStepKind;
  icon: IconName;
  color: string | null;
  onIcon: (icon: IconName) => void;
  onColor: (color: string | null) => void;
}> = ({ kind, icon, color, onIcon, onColor }) => {
  const { label, hint } = STEP_LABELS[kind];
  const changed = icon !== DEFAULT_MODERN.stepIcons[kind];
  return (
    <section role="region" aria-label={`${label} step settings`} className="space-y-4">
      <div>
        <h4 className="text-sm font-medium">{label}</h4>
        <p className="text-caption text-muted-foreground mt-0.5">
          A step in the work timeline: {hint}. A color tints its icon and the line beside it when opened; a failed step stays red.
        </p>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Icon</Label>
          {changed && (
            <button
              type="button"
              onClick={() => { onIcon(DEFAULT_MODERN.stepIcons[kind]); }}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              <Undo2 className="h-3 w-3" />
              Reset icon
            </button>
          )}
        </div>
        <IconPicker value={icon} onChange={onIcon} />
      </div>
      <ColorField name={label} title="Color" unsetLabel="built-in gray" value={color} onChange={onColor} />
    </section>
  );
};

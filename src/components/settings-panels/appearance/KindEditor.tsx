import React from "react";
import { Lock } from "lucide-react";
import type {
  MessageKindConfig,
  Palette,
  PaletteName,
  IconName,
} from "@/lib/messageRenderingConfig";
import { ALLOWED_ICONS } from "@/lib/messageRenderingConfig";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { IconRenderer } from "./iconMap";
import { TooltipProvider, TooltipSimple } from "@/components/ui/tooltip-modern";
import { cn } from "@/lib/utils";

interface KindEditorProps {
  kind: MessageKindConfig;
  palette: Palette;
  onChange: (patch: Partial<MessageKindConfig>) => void;
  onResetKind: () => void;
}

export const KindEditor: React.FC<KindEditorProps> = ({
  kind,
  palette,
  onChange,
  onResetKind,
}) => {
  const paletteEntries = Object.entries(palette) as [PaletteName, Palette[PaletteName]][];

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

      {/* Visibility in compact mode */}
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
              ? "Forced visible — this kind is a turn boundary."
              : "Collapses into the group marker when compact mode is on."}
          </p>
        </div>
        <Switch
          checked={kind.hiddenInCompact}
          disabled={kind.compactBoundaryLocked}
          onCheckedChange={(checked) => onChange({ hiddenInCompact: checked })}
        />
      </div>

      {/* Accent color */}
      <div className="space-y-2">
        <Label>Accent color</Label>
        <p className="text-caption text-muted-foreground">
          Palette name — edit the palette once to retint every kind that uses it.
        </p>
        <div className="flex flex-wrap gap-2">
          {paletteEntries.map(([name, entry]) => {
            const active = kind.accentColor === name;
            return (
              <button
                key={name}
                type="button"
                onClick={() => onChange({ accentColor: name })}
                className={cn(
                  "flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-xs transition-all",
                  active
                    ? "border-foreground/60 bg-muted/40 shadow-sm"
                    : "border-border hover:bg-muted/30",
                )}
              >
                <span
                  className="h-3 w-3 rounded-full border border-border/60"
                  style={{ backgroundColor: entry.swatch }}
                />
                <span>{name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Icon */}
      <div className="space-y-2">
        <Label>Icon</Label>
        <TooltipProvider delayDuration={200}>
          <div className="flex flex-wrap gap-1.5 rounded border border-border p-2 bg-muted/20">
            {(ALLOWED_ICONS as readonly IconName[]).map((name) => {
              const active = kind.icon === name;
              return (
                <TooltipSimple key={name} content={name}>
                  <button
                    type="button"
                    onClick={() => onChange({ icon: name })}
                    aria-label={name}
                    className={cn(
                      "h-8 w-8 rounded flex items-center justify-center text-foreground/80 transition-colors",
                      active
                        ? "bg-primary/20 ring-1 ring-primary/40"
                        : "hover:bg-muted/60",
                    )}
                  >
                    {name === "none" ? (
                      <span className="text-[10px] text-muted-foreground">—</span>
                    ) : (
                      <IconRenderer name={name} className="h-4 w-4" />
                    )}
                  </button>
                </TooltipSimple>
              );
            })}
          </div>
        </TooltipProvider>
      </div>

      {/* Header label override */}
      <div className="space-y-2">
        <Label htmlFor="header-label">Header label</Label>
        <p className="text-caption text-muted-foreground">
          Leave blank to hide the header bar.
        </p>
        <Input
          id="header-label"
          value={kind.headerLabel ?? ""}
          placeholder="(no header)"
          onChange={(e) =>
            onChange({
              headerLabel: e.target.value === "" ? null : e.target.value,
            })
          }
        />
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

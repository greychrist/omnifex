import React from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  TabIndicators,
  TabIndicatorKey,
  TabIndicatorSize,
  TabIndicatorStyle,
  Palette,
} from "@/lib/messageRenderingConfig";
import { resolveIndicatorColor } from "@/lib/tabIndicatorStyle";
import { IconPicker } from "@/components/settings-panels/appearance/IconPicker";
import { TabStatusGlyph } from "@/components/TabStatusGlyph";
import { cn } from "@/lib/utils";

interface TabIndicatorsEditorProps {
  indicators: TabIndicators;
  palette: Palette;
  onChange: (next: TabIndicators) => void;
}

const STATES: { key: TabIndicatorKey; label: string }[] = [
  { key: "error", label: "Error" },
  { key: "permission", label: "Permission request" },
  { key: "question", label: "Question waiting" },
  { key: "complete", label: "Completed" },
];

const SIZES: { value: TabIndicatorSize; label: string }[] = [
  { value: "sm", label: "Small" },
  { value: "md", label: "Medium" },
  { value: "lg", label: "Large" },
];

/** Native colour input (writes hex), mirroring the kind editor's accent-colour
 *  control. Defaults stay as theme-aware palette names until the user changes
 *  one, at which point it becomes an explicit hex. */
const ColorControl: React.FC<{
  value: string;
  palette: Palette;
  onChange: (color: string) => void;
}> = ({ value, palette, onChange }) => {
  const hex = resolveIndicatorColor(value, palette);
  return (
    <input
      type="color"
      value={hex}
      onChange={(e) => { onChange(e.target.value); }}
      aria-label="Colour"
      className="h-8 w-9 cursor-pointer rounded-md border border-border bg-background p-1 focus:outline-none focus:ring-1 focus:ring-ring"
    />
  );
};

/**
 * Editor for the per-tab status glyphs (TabManager). Icon + colour are
 * per-state; size, bordered chip, and background opacity are shared chrome.
 * Lives in the General settings tab.
 */
export const TabIndicatorsEditor: React.FC<TabIndicatorsEditorProps> = ({
  indicators,
  palette,
  onChange,
}) => {
  const setState = (key: TabIndicatorKey, patch: Partial<TabIndicatorStyle>) => {
    onChange({ ...indicators, [key]: { ...indicators[key], ...patch } });
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-heading-4">Tab status indicators</h3>
        <p className="text-caption text-muted-foreground mt-1">
          The little glyph in each tab. Pick the icon and colour per state; size,
          border, and background opacity apply to all of them. They always flash.
        </p>
      </div>

      <div className="space-y-2">
        {STATES.map(({ key, label }) => (
          <div key={key} className="flex items-center gap-3">
            <div className="flex w-40 shrink-0 items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center">
                <TabStatusGlyph
                  style={indicators[key]}
                  indicators={indicators}
                  palette={palette}
                  ariaLabel={`${label} preview`}
                />
              </span>
              <Label className="text-caption">{label}</Label>
            </div>
            <div className="w-44 shrink-0">
              <IconPicker
                value={indicators[key].icon}
                onChange={(icon) => { setState(key, { icon }); }}
              />
            </div>
            <ColorControl
              value={indicators[key].color}
              palette={palette}
              onChange={(color) => { setState(key, { color }); }}
            />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-1">
        <div>
          <Label className="mb-1 block text-caption">Size</Label>
          <Select
            value={indicators.size}
            onValueChange={(v) => { onChange({ ...indicators, size: v as TabIndicatorSize }); }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SIZES.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 sm:pt-6">
          <Switch
            id="tab-indicator-bordered"
            checked={indicators.bordered}
            onCheckedChange={(v) => { onChange({ ...indicators, bordered: v }); }}
          />
          <Label htmlFor="tab-indicator-bordered" className="cursor-pointer text-caption">
            Bordered chip
          </Label>
        </div>
        <div className={cn("flex items-center gap-2 sm:pt-6", !indicators.bordered && "opacity-50")}>
          <Label htmlFor="tab-indicator-bg-opacity" className="shrink-0 text-caption">
            Bg opacity
          </Label>
          <input
            id="tab-indicator-bg-opacity"
            type="range"
            min={0}
            max={100}
            step={5}
            value={indicators.bgOpacity}
            onChange={(e) => { onChange({ ...indicators, bgOpacity: parseInt(e.target.value, 10) }); }}
            disabled={!indicators.bordered}
            className="flex-1 cursor-pointer disabled:cursor-not-allowed accent-foreground"
          />
          <span className="font-mono text-caption text-muted-foreground w-9 text-right">
            {indicators.bgOpacity}%
          </span>
        </div>
      </div>
    </div>
  );
};

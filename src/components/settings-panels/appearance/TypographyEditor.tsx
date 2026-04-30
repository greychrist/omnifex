import React from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  FontFamily,
  FontSize,
  FontWeight,
  IconSize,
  Typography,
  TypographyStyle,
} from "@/lib/messageRenderingConfig";

interface TypographyEditorProps {
  typography: Typography;
  onChange: (next: Typography) => void;
}

const FAMILIES: { value: FontFamily; label: string }[] = [
  { value: "sans", label: "Sans-serif" },
  { value: "serif", label: "Serif" },
  { value: "mono", label: "Monospace" },
];

const SIZES: { value: FontSize; label: string }[] = [
  { value: "xs", label: "Extra small" },
  { value: "sm", label: "Small" },
  { value: "base", label: "Base" },
  { value: "lg", label: "Large" },
];

const WEIGHTS: { value: FontWeight; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "medium", label: "Medium" },
  { value: "semibold", label: "Semibold" },
  { value: "bold", label: "Bold" },
];

const ICON_SIZES: { value: IconSize; label: string }[] = [
  { value: "xs", label: "Extra small" },
  { value: "sm", label: "Small" },
  { value: "base", label: "Base" },
  { value: "lg", label: "Large" },
  { value: "xl", label: "Extra large" },
];

interface StyleRowProps {
  title: string;
  description: string;
  style: TypographyStyle;
  onChange: (next: TypographyStyle) => void;
}

const StyleRow: React.FC<StyleRowProps> = ({ title, description, style, onChange }) => (
  <div className="space-y-3 pt-4 border-t border-border first:border-t-0 first:pt-0">
    <div>
      <Label>{title}</Label>
      <p className="text-caption text-muted-foreground mt-1">{description}</p>
    </div>
    <div className="grid grid-cols-3 gap-3">
      <div>
        <Label className="mb-1 block text-caption">Family</Label>
        <Select
          value={style.family}
          onValueChange={(v) => onChange({ ...style, family: v as FontFamily })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {FAMILIES.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="mb-1 block text-caption">Size</Label>
        <Select
          value={style.size}
          onValueChange={(v) => onChange({ ...style, size: v as FontSize })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {SIZES.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="mb-1 block text-caption">Weight</Label>
        <Select
          value={style.weight}
          onValueChange={(v) => onChange({ ...style, weight: v as FontWeight })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {WEIGHTS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
    <div className="flex items-center gap-2">
      <Switch
        id={`${title}-italic`}
        checked={style.italic}
        onCheckedChange={(v) => onChange({ ...style, italic: v })}
      />
      <Label htmlFor={`${title}-italic`} className="cursor-pointer">Italic</Label>
    </div>
  </div>
);

export const TypographyEditor: React.FC<TypographyEditorProps> = ({ typography, onChange }) => {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-heading-4">Typography</h3>
        <p className="text-caption text-muted-foreground mt-1">
          Global font style for message headers and body text. Applies everywhere a header
          label or user-typed message is rendered.
        </p>
      </div>
      <StyleRow
        title="Header"
        description={'The small label row above a card (e.g. "You", "Claude Code", "Execution Complete").'}
        style={typography.header}
        onChange={(next) => onChange({ ...typography, header: next })}
      />
      <StyleRow
        title="Content"
        description="User message body text. (Assistant markdown bodies keep their prose defaults.)"
        style={typography.content}
        onChange={(next) => onChange({ ...typography, content: next })}
      />
      <div className="space-y-3 pt-4 border-t border-border">
        <div>
          <Label>Card icon</Label>
          <p className="text-caption text-muted-foreground mt-1">
            Size and chrome of the colored icon on the left of each message card. Independent from text size.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="mb-1 block text-caption">Size</Label>
            <Select
              value={typography.icon.size}
              onValueChange={(v) =>
                onChange({ ...typography, icon: { ...typography.icon, size: v as IconSize } })
              }
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ICON_SIZES.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="icon-bordered"
            checked={typography.icon.bordered}
            onCheckedChange={(v) =>
              onChange({ ...typography, icon: { ...typography.icon, bordered: v } })
            }
          />
          <Label htmlFor="icon-bordered" className="cursor-pointer">
            Bordered chip
          </Label>
          <span className="text-caption text-muted-foreground">
            (icon punches out of the card with a swatch-tinted border + chat background)
          </span>
        </div>
        <div className={cn("flex items-center gap-3", !typography.icon.bordered && "opacity-50")}>
          <Label htmlFor="icon-bg-opacity" className="shrink-0 w-32">
            Background opacity
          </Label>
          <input
            id="icon-bg-opacity"
            type="range"
            min={0}
            max={100}
            step={5}
            value={typography.icon.bgOpacity}
            onChange={(e) =>
              onChange({
                ...typography,
                icon: { ...typography.icon, bgOpacity: parseInt(e.target.value, 10) },
              })
            }
            disabled={!typography.icon.bordered}
            className="flex-1 cursor-pointer disabled:cursor-not-allowed accent-foreground"
          />
          <span className="font-mono text-caption text-muted-foreground w-10 text-right">
            {typography.icon.bgOpacity}%
          </span>
        </div>
      </div>
    </div>
  );
};

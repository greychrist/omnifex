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
  FontSize,
  FontWeight,
  Typography,
  TypographyStyle,
} from "@/lib/messageRenderingConfig";
import type { Typeface } from "@/lib/typefaceCatalog";
import { TypefacePicker } from "./TypefacePicker";

interface TypographyEditorProps {
  typography: Typography;
  onChange: (next: Typography) => void;
}

const SIZES: { value: FontSize; label: string }[] = [
  { value: "xxs", label: "Extra extra small" },
  { value: "xs", label: "Extra small" },
  { value: "sm", label: "Small" },
  { value: "base", label: "Base" },
  { value: "lg", label: "Large" },
];

// Ordered light → heavy. Tailwind v4 maps each to its standard CSS weight
// (thin = 100, extralight = 200, … black = 900). Not every bundled typeface
// ships every weight (e.g. IBM Plex Serif/Mono are single-weight 400, Plus
// Jakarta and Oxanium start at 200) — the browser falls back to the closest
// available weight on a miss, so all options remain selectable.
const WEIGHTS: { value: FontWeight; label: string }[] = [
  { value: "thin", label: "Thin" },
  { value: "extralight", label: "Extra light" },
  { value: "light", label: "Light" },
  { value: "normal", label: "Normal" },
  { value: "medium", label: "Medium" },
  { value: "semibold", label: "Semibold" },
  { value: "bold", label: "Bold" },
  { value: "extrabold", label: "Extra bold" },
  { value: "black", label: "Black" },
];

interface TextColumnProps {
  title: string;
  description: string;
  style: TypographyStyle;
  italicId: string;
  onChange: (next: TypographyStyle) => void;
}

const TextColumn: React.FC<TextColumnProps> = ({
  title,
  description,
  style,
  italicId,
  onChange,
}) => (
  <div className="space-y-3">
    <div>
      <Label>{title}</Label>
      <p className="text-caption text-muted-foreground mt-1">{description}</p>
    </div>
    <TypefacePicker
      value={style.typeface}
      onChange={(next: Typeface) => { onChange({ ...style, typeface: next }); }}
    />
    <div>
      <Label className="mb-1 block text-caption">Size</Label>
      <Select
        value={style.size}
        onValueChange={(v) => { onChange({ ...style, size: v as FontSize }); }}
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
    <div>
      <Label className="mb-1 block text-caption">Weight</Label>
      <Select
        value={style.weight}
        onValueChange={(v) => { onChange({ ...style, weight: v as FontWeight }); }}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WEIGHTS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
    <div className="flex items-center gap-2">
      <Switch
        id={italicId}
        checked={style.italic}
        onCheckedChange={(v) => { onChange({ ...style, italic: v }); }}
      />
      <Label htmlFor={italicId} className="cursor-pointer">
        Italic
      </Label>
    </div>
  </div>
);

interface IconColumnProps {
  icon: Typography["icon"];
  onChange: (next: Typography["icon"]) => void;
}

const IconColumn: React.FC<IconColumnProps> = ({ icon, onChange }) => (
  <div className="space-y-3">
    <div>
      <Label>Card icon</Label>
      <p className="text-caption text-muted-foreground mt-1">
        Chrome of the colored icon on the left of each card. Independent from text.
      </p>
    </div>
    <div className="flex items-center gap-2">
      <Switch
        id="icon-bordered"
        checked={icon.bordered}
        onCheckedChange={(v) => { onChange({ ...icon, bordered: v }); }}
      />
      <Label htmlFor="icon-bordered" className="cursor-pointer">
        Bordered chip
      </Label>
    </div>
    <div className={cn("flex items-center gap-3", !icon.bordered && "opacity-50")}>
      <Label htmlFor="icon-bg-opacity" className="shrink-0 text-caption">
        Bg opacity
      </Label>
      <input
        id="icon-bg-opacity"
        type="range"
        min={0}
        max={100}
        step={5}
        value={icon.bgOpacity}
        onChange={(e) => { onChange({ ...icon, bgOpacity: parseInt(e.target.value, 10) }); }}
        disabled={!icon.bordered}
        className="flex-1 cursor-pointer disabled:cursor-not-allowed accent-foreground"
      />
      <span className="font-mono text-caption text-muted-foreground w-10 text-right">
        {icon.bgOpacity}%
      </span>
    </div>
  </div>
);

export const TypographyEditor: React.FC<TypographyEditorProps> = ({ typography, onChange }) => {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-heading-4">Typography</h3>
        <p className="text-caption text-muted-foreground mt-1">
          Per-element typeface, size, and weight for chat messages. Pick any bundled
          font from the Header and Content columns; the App font (above) controls the
          rest of the app.
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <TextColumn
          title="Header"
          description={'The small label row above a card (e.g. "You", "Claude Code").'}
          style={typography.header}
          italicId="typography-header-italic"
          onChange={(next) => { onChange({ ...typography, header: next }); }}
        />
        <TextColumn
          title="Content"
          description="Body text for chat messages — user prompts and assistant markdown."
          style={typography.content}
          italicId="typography-content-italic"
          onChange={(next) => { onChange({ ...typography, content: next }); }}
        />
        <IconColumn
          icon={typography.icon}
          onChange={(next) => { onChange({ ...typography, icon: next }); }}
        />
      </div>
    </div>
  );
};

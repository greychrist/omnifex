import React from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MODERN_ANSWER_SIZES,
  type FontSize,
  type FontWeight,
  type ModernFont,
  type ModernStyle,
  type Typography,
  type TypographyStyle,
} from "@/lib/messageRenderingConfig";
import type { Typeface } from "@/lib/typefaceCatalog";
import { TypefacePicker } from "./TypefacePicker";
import { Segmented } from "./Segmented";

interface TextEditorProps {
  typography: Typography;
  onTypography: (next: Typography) => void;
  modern: ModernStyle;
  onModern: (next: ModernStyle) => void;
}

const FONT_OPTIONS: { value: ModernFont; label: string }[] = [
  { value: "geist", label: "Geist" },
  { value: "content", label: "Chat text typeface" },
];

const SIZES: { value: FontSize; label: string }[] = [
  { value: "xxs", label: "Extra extra small" },
  { value: "xs", label: "Extra small" },
  { value: "sm", label: "Small" },
  { value: "base", label: "Base" },
  { value: "lg", label: "Large" },
];

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
  onChange: (next: TypographyStyle) => void;
}

const TextColumn: React.FC<TextColumnProps> = ({
  title,
  description,
  style,
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
  </div>
);

export const TextEditor: React.FC<TextEditorProps> = ({ typography, onTypography, modern, onModern }) => (
  <section role="region" aria-label="Text settings" className="space-y-5">
    <div>
      <h4 className="text-sm font-medium">Text</h4>
      <p className="text-caption text-muted-foreground mt-0.5">
        The text the chat is set in. The App font controls the rest of the app.
      </p>
    </div>
    <div className="flex flex-wrap items-center gap-6">
      <div className="space-y-1">
        <Label>Answer font</Label>
        <Segmented label="Font" value={modern.font} options={FONT_OPTIONS} onChange={(font) => { onModern({ ...modern, font }); }} />
      </div>
      <div className="space-y-1">
        <Label>Answer size</Label>
        <Segmented
          label="Answer size"
          value={modern.answerSize}
          options={MODERN_ANSWER_SIZES.map((s) => ({ value: s, label: `${String(s)}px` }))}
          onChange={(answerSize) => { onModern({ ...modern, answerSize }); }}
        />
      </div>
    </div>
    <div className="max-w-sm">
      <TextColumn
        title="Chat text"
        description="Prompts and Claude's markdown."
        style={typography.content}
        onChange={(next) => { onTypography({ ...typography, content: next }); }}
      />
    </div>
  </section>
);

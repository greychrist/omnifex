import React from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TYPEFACE_CATALOG, type FamilyTag, type Typeface } from "@/lib/typefaceCatalog";

interface TypefacePickerProps {
  label?: string;
  value: Typeface;
  onChange: (next: Typeface) => void;
}

const GROUP_ORDER: { tag: FamilyTag; label: string }[] = [
  { tag: "sans", label: "Sans" },
  { tag: "display-sans", label: "Display" },
  { tag: "serif", label: "Serif" },
  { tag: "humanist", label: "Humanist" },
  { tag: "mono", label: "Mono" },
];

export const TypefacePicker: React.FC<TypefacePickerProps> = ({
  label = "Font",
  value,
  onChange,
}) => {
  return (
    <div>
      <Label className="mb-1 block text-caption">{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as Typeface)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GROUP_ORDER.map((group) => {
            const items = TYPEFACE_CATALOG.filter((t) => t.family === group.tag);
            if (items.length === 0) return null;
            return (
              <SelectGroup key={group.tag}>
                <SelectLabel>{group.label}</SelectLabel>
                {items.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    <span style={{ fontFamily: t.cssFamily }}>{t.label}</span>
                  </SelectItem>
                ))}
              </SelectGroup>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
};

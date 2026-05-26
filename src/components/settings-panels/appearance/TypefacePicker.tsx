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
  /**
   * Restrict the dropdown to the given family tags. Use this for surfaces
   * where the choice is semantically constrained — e.g. the terminal picker
   * passes `['mono']` because non-mono fonts break xterm's column grid.
   * Defaults to every family (all groups visible).
   */
  families?: readonly FamilyTag[];
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
  families,
}) => {
  const visibleGroups = families
    ? GROUP_ORDER.filter((g) => families.includes(g.tag))
    : GROUP_ORDER;
  return (
    <div>
      <Label className="mb-1 block text-caption">{label}</Label>
      <Select value={value} onValueChange={(v) => { onChange(v as Typeface); }}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {visibleGroups.map((group) => {
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

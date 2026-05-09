import React from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppFont } from "@/contexts/AppFontContext";
import { APP_FONT_CHOICES, type Typeface } from "@/lib/typefaceCatalog";

export const AppFontPicker: React.FC = () => {
  const { appFont, setAppFont, isLoading } = useAppFont();

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-heading-4">App font</h3>
        <p className="text-caption text-muted-foreground mt-1">
          Global UI typeface — affects sidebar, settings, dialogs, and project list.
          Chat fonts are configured separately in Typography below.
        </p>
      </div>
      <div className="max-w-xs">
        <Label className="mb-1 block text-caption">Typeface</Label>
        <Select
          value={appFont}
          onValueChange={(v) => setAppFont(v as Typeface)}
          disabled={isLoading}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {APP_FONT_CHOICES.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                <span style={{ fontFamily: t.cssFamily }}>{t.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
};

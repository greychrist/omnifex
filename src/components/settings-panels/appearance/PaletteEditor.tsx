import React from "react";
import type {
  Palette,
  PaletteName,
  PaletteEntry,
} from "@/lib/messageRenderingConfig";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface PaletteEditorProps {
  palette: Palette;
  onChange: (name: PaletteName, patch: Partial<PaletteEntry>) => void;
}

export const PaletteEditor: React.FC<PaletteEditorProps> = ({ palette, onChange }) => {
  const entries = Object.entries(palette) as [PaletteName, PaletteEntry][];

  return (
    <div className="space-y-3">
      <div>
        <Label>Palette</Label>
        <p className="text-caption text-muted-foreground">
          Each swatch retints every message kind assigned to that palette name.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {entries.map(([name, entry]) => (
          <PaletteRow
            key={name}
            name={name}
            entry={entry}
            onChange={(patch) => { onChange(name, patch); }}
          />
        ))}
      </div>
    </div>
  );
};

interface PaletteRowProps {
  name: PaletteName;
  entry: PaletteEntry;
  onChange: (patch: Partial<PaletteEntry>) => void;
}

const PaletteRow: React.FC<PaletteRowProps> = ({ name, entry, onChange }) => {
  const inputId = `palette-${name}`;
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md border border-border px-3 py-2 bg-muted/10",
      )}
    >
      <label htmlFor={inputId} className="flex items-center gap-2 flex-1 cursor-pointer">
        <span
          className="h-5 w-5 rounded-full border border-border/60 flex-shrink-0"
          style={{ backgroundColor: entry.swatch }}
        />
        <span className="text-xs font-medium">{name}</span>
      </label>
      <input
        id={inputId}
        type="color"
        value={entry.swatch}
        onChange={(e) => { onChange({ swatch: e.target.value }); }}
        className="h-6 w-10 rounded cursor-pointer bg-transparent border border-border/40"
        title={`Edit ${name} swatch`}
      />
      <span className="font-mono text-[10px] text-muted-foreground/80 w-16 text-right">
        {entry.swatch}
      </span>
    </div>
  );
};

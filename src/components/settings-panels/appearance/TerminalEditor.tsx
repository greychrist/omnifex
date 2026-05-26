import React from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  Terminal,
  TerminalCursorStyle,
} from "@/lib/messageRenderingConfig";
import type { Typeface } from "@/lib/typefaceCatalog";
import { TypefacePicker } from "./TypefacePicker";

interface TerminalEditorProps {
  terminal: Terminal;
  onChange: (next: Terminal) => void;
}

// Discrete pick list — gives users sensible options without the fiddliness
// of a number input. Range covers ~half-step legibility floor to a size
// that's comfortable on a 27" display from across the room.
const FONT_SIZES: number[] = [10, 11, 12, 13, 14, 15, 16, 18, 20];

const CURSOR_STYLES: { value: TerminalCursorStyle; label: string }[] = [
  { value: "block", label: "Block" },
  { value: "underline", label: "Underline" },
  { value: "bar", label: "Bar" },
];

/**
 * Appearance → Terminal. Today: font, font size, cursor style.
 * Designed to grow — cursor blink, line height, scrollback, theme — without
 * restructuring.
 */
export const TerminalEditor: React.FC<TerminalEditorProps> = ({ terminal, onChange }) => {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-heading-4">Terminal</h3>
        <p className="text-caption text-muted-foreground mt-1">
          Settings for the xterm surface in Terminal mode. Only monospaced
          typefaces are shown — variable-width fonts break xterm's column grid.
        </p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-3">
          <TypefacePicker
            value={terminal.typeface}
            onChange={(next: Typeface) => { onChange({ ...terminal, typeface: next }); }}
            families={["mono"]}
          />
        </div>

        <div className="space-y-3">
          <div>
            <Label className="mb-1 block text-caption">Font size</Label>
            <Select
              value={String(terminal.fontSize)}
              onValueChange={(v) => {
                const n = Number.parseInt(v, 10);
                if (!Number.isNaN(n)) onChange({ ...terminal, fontSize: n });
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONT_SIZES.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {s} px
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <Label className="mb-1 block text-caption">Cursor style</Label>
            <Select
              value={terminal.cursorStyle}
              onValueChange={(v) => { onChange({ ...terminal, cursorStyle: v as TerminalCursorStyle }); }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURSOR_STYLES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
};

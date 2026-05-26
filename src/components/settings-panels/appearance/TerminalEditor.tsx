import React from "react";
import type { Terminal } from "@/lib/messageRenderingConfig";
import type { Typeface } from "@/lib/typefaceCatalog";
import { TypefacePicker } from "./TypefacePicker";

interface TerminalEditorProps {
  terminal: Terminal;
  onChange: (next: Terminal) => void;
}

/**
 * Appearance → Terminal. Mirrors `TypographyEditor` but scoped to xterm-only
 * settings. Today: a single mono-restricted font picker. Designed to grow
 * — line height, font size, cursor style, theme — without restructuring.
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
      </div>
    </div>
  );
};

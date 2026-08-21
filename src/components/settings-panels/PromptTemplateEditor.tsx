import React from 'react';
import { Button } from '@/components/ui/button';
import { RotateCcw, Check, AlertCircle } from 'lucide-react';

/**
 * The textarea + "Reset to default" + saved/error affordances shared by every
 * system-prompt panel. Purely presentational — state lives in
 * `usePromptTemplate`, so a panel can wrap this in whatever switches and help
 * text it needs.
 */

export interface PromptTemplateEditorProps {
  value: string;
  onChange: (next: string) => void;
  onReset: () => void;
  /** True when the editor already holds the shipped default. */
  isDefault: boolean;
  saved: boolean;
  error: string | null;
  rows?: number;
  'aria-label'?: string;
}

export const PromptTemplateEditor: React.FC<PromptTemplateEditorProps> = ({
  value,
  onChange,
  onReset,
  isDefault,
  saved,
  error,
  rows = 18,
  'aria-label': ariaLabel,
}) => (
  <>
    <textarea
      value={value}
      onChange={(e) => { onChange(e.target.value); }}
      spellCheck={false}
      rows={rows}
      aria-label={ariaLabel}
      className="w-full font-mono text-xs rounded-md border border-border/60 bg-background p-3 resize-y min-h-[300px] focus:outline-none focus:ring-1 focus:ring-ring"
    />

    <div className="flex items-center gap-2 mt-2">
      <Button
        size="sm"
        variant="outline"
        onClick={onReset}
        disabled={isDefault}
        title="Replace the editor with OmniFex's default prompt. Saves automatically."
      >
        <RotateCcw className="mr-2 h-3.5 w-3.5" /> Reset to default
      </Button>
      {saved && (
        <span className="inline-flex items-center text-[11px] text-emerald-400">
          <Check className="mr-1 h-3 w-3" /> Saved
        </span>
      )}
      {error && (
        <span className="inline-flex items-center gap-1 text-[11px] text-red-400">
          <AlertCircle className="h-3 w-3" />
          {error}
        </span>
      )}
    </div>
  </>
);

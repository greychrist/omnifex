import React from 'react';
import { cn } from '@/lib/utils';
import type { ViewMode } from '@/lib/messageRenderingConfig';

/**
 * `all` is Verbose plus every kind set to "Never" in Appearance settings.
 * `modern` is Compact's filtering drawn as a conversation: prompt bubbles,
 * plain prose, and each run of work folded into a Chain of Thought.
 */
export type { ViewMode };

const MODES: { mode: ViewMode; label: string; title: string }[] = [
  { mode: 'compact', label: 'Compact', title: 'Fold verbose-only messages away' },
  { mode: 'verbose', label: 'Verbose', title: 'Show everything except kinds set to Never' },
  { mode: 'all', label: 'All', title: 'Show everything, including kinds set to Never' },
  { mode: 'modern', label: 'Modern', title: 'A conversation: prompts, answers, and the work between them folded away' },
];

interface Props {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  className?: string;
}

export const SessionViewToggle: React.FC<Props> = ({ mode, onChange, className }) => {
  return (
    // Two by two: four labels do not fit across the composer's 160px column.
    <div className={cn('inline-grid grid-cols-2 gap-0.5 rounded-md border border-border bg-muted/30 p-0.5', className)}>
      {MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          title={m.title}
          onClick={() => { onChange(m.mode); }}
          className={cn(
            'flex-1 justify-center px-2 py-1 text-xs rounded',
            mode === m.mode
              ? 'bg-background shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
};

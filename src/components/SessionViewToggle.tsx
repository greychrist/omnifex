import React from 'react';
import { cn } from '@/lib/utils';
import type { ViewMode } from '@/lib/messageRenderingConfig';

export type { ViewMode };

const MODES: { mode: ViewMode; label: string; title: string }[] = [
  { mode: 'standard', label: 'Standard', title: 'The conversation: prompts, answers, and the work between them folded away' },
  { mode: 'expanded', label: 'Expanded', title: 'Every record in the transcript, drawn the same way' },
];

interface Props {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  className?: string;
}

export const SessionViewToggle: React.FC<Props> = ({ mode, onChange, className }) => {
  return (
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

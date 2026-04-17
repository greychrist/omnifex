import React from 'react';
import { cn } from '@/lib/utils';

export type ViewMode = 'compact' | 'verbose';

interface Props {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

export const SessionViewToggle: React.FC<Props> = ({ mode, onChange }) => {
  return (
    <div className="inline-flex rounded-md border border-border/60 bg-background text-[11px] font-mono overflow-hidden">
      {(['compact', 'verbose'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            'px-2 py-0.5 transition-colors',
            mode === m
              ? 'bg-foreground/10 text-foreground'
              : 'text-muted-foreground hover:bg-foreground/5',
          )}
        >
          {m === 'compact' ? 'Compact' : 'Verbose'}
        </button>
      ))}
    </div>
  );
};

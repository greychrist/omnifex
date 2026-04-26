import React from 'react';
import { cn } from '@/lib/utils';

export type ViewMode = 'compact' | 'verbose';

interface Props {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
}

export const SessionViewToggle: React.FC<Props> = ({ mode, onChange }) => {
  return (
    <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
      {(['compact', 'verbose'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            'px-2 py-1 text-xs rounded',
            mode === m
              ? 'bg-background shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {m === 'compact' ? 'Compact' : 'Verbose'}
        </button>
      ))}
    </div>
  );
};

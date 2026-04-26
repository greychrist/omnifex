import * as React from 'react';
import { Folder } from 'lucide-react';
import { cn } from '@/lib/utils';

export const ProjectPathBadge: React.FC<{ path: string }> = ({ path }) => {
  const display = path.replace(/^\/Users\/[^/]+/, '~');
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono font-medium max-w-[40ch]',
        'bg-background text-foreground shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]',
      )}
      title={path}
    >
      <Folder className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">{display}</span>
    </span>
  );
};

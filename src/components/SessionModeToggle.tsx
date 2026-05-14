import { cn } from '@/lib/utils';
import { Terminal, MessageSquare } from 'lucide-react';

interface SessionModeToggleProps {
  mode: 'sdk' | 'tui';
  onChange: (mode: 'sdk' | 'tui') => void;
  disabled?: boolean;
  disabledReason?: string;
}

export function SessionModeToggle({
  mode, onChange, disabled, disabledReason,
}: SessionModeToggleProps) {
  return (
    <div
      className={cn(
        'inline-flex rounded-md border border-border bg-muted/30 p-0.5',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
      title={disabled ? disabledReason : undefined}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => { onChange('sdk'); }}
        className={cn(
          'flex items-center gap-1 px-2 py-1 text-xs rounded disabled:pointer-events-none',
          mode === 'sdk' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <MessageSquare className="h-3 w-3" />
        SDK
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => { onChange('tui'); }}
        className={cn(
          'flex items-center gap-1 px-2 py-1 text-xs rounded disabled:pointer-events-none',
          mode === 'tui' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Terminal className="h-3 w-3" />
        Terminal
      </button>
    </div>
  );
}

import React, { useCallback, useRef, useEffect } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Floating find-in-chat bar. Mounts inside the chat pane's `relative`
 * wrapper at the top-right. Consumes state from `useFindInChat` upstream;
 * this component is purely presentational + keyboard plumbing.
 *
 * The root carries `data-find-skip` so the hook's TreeWalker skips this
 * bar's own DOM — otherwise the user's query string in the input would
 * become a self-match.
 *
 * See `docs/superpowers/specs/2026-05-11-find-in-chat-design.md`.
 */
export interface FindBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  count: number;
  /** 0-based; only meaningful when count > 0. */
  activeIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  className?: string;
}

export const FindBar: React.FC<FindBarProps> = ({
  query,
  onQueryChange,
  count,
  activeIndex,
  onNext,
  onPrev,
  onClose,
  className,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus on mount. Using useEffect rather than the HTML `autoFocus`
  // attribute so the focus reliably happens even when the bar is mounted
  // mid-session inside an already-busy React tree.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (count === 0) return;
        if (e.shiftKey) onPrev();
        else onNext();
      }
    },
    [count, onNext, onPrev, onClose],
  );

  const disabled = count === 0;
  const display = count === 0 ? '0/0' : `${activeIndex + 1}/${count}`;

  return (
    <div
      data-find-skip
      className={cn(
        'absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-md border border-border/60 bg-background/95 px-2 py-1 shadow-sm backdrop-blur-sm',
        className,
      )}
    >
      <input
        ref={inputRef}
        data-testid="find-input"
        value={query}
        onChange={(e) => { onQueryChange(e.target.value); }}
        onKeyDown={handleKeyDown}
        placeholder="Find in chat"
        aria-label="Find in chat"
        className="h-7 w-48 rounded border border-border/50 bg-background px-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
      />
      <span
        data-testid="find-count"
        className="select-none px-1 text-xs tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        {display}
      </span>
      <Button
        data-testid="find-prev"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={disabled}
        onClick={onPrev}
        aria-label="Previous match"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        data-testid="find-next"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={disabled}
        onClick={onNext}
        aria-label="Next match"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      <Button
        data-testid="find-close"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onClose}
        aria-label="Close find"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
};

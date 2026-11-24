import { useMemo, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface MultiSelectFilterProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  renderOption?: (value: string) => string;
  searchable?: boolean;
  className?: string;
}

/** An empty selection means "all", matching the query layer. */
export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  renderOption = (v) => v,
  searchable = false,
  className,
}: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const summary =
    selected.length === 0
      ? `All ${label.toLowerCase()}`
      : selected.length === 1
        ? renderOption(selected[0])
        : `${selected.length} ${label.toLowerCase()}`;

  const toggle = (value: string): void => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <div className={cn('relative', className)}>
      <Button
        size="sm"
        variant={selected.length ? 'default' : 'outline'}
        onClick={() => setOpen((o) => !o)}
        className="max-w-[22ch]"
      >
        <span className="truncate">{summary}</span>
        <ChevronDown className="ml-1 h-3.5 w-3.5 shrink-0" />
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 max-h-72 w-64 overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg">
            {searchable && (
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Filter ${label.toLowerCase()}…`}
                className="mb-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
              />
            )}

            {selected.length > 0 && (
              <button
                onClick={() => onChange([])}
                className="mb-1 flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent"
              >
                <X className="h-3 w-3" />
                Clear ({selected.length})
              </button>
            )}

            {visible.map((option) => (
              <button
                key={option}
                onClick={() => toggle(option)}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-accent"
                title={option}
              >
                <Check
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    selected.includes(option) ? 'opacity-100' : 'opacity-0',
                  )}
                />
                <span className="truncate">{renderOption(option)}</span>
              </button>
            ))}

            {visible.length === 0 && (
              <div className="px-2 py-2 text-xs text-muted-foreground">No matches</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

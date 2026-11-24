import React, { useMemo, useState } from 'react';
import { Check, ChevronDown, Infinity as InfinityIcon } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { AccountBadge } from '@/components/AccountBadge';
import { cn } from '@/lib/utils';

export const ALL_ACCOUNTS = 'all';

export const UNASSIGNED = '(unassigned)';

const TRIGGER_CLASS = 'h-7 w-auto gap-1.5 pl-1 text-xs [&>svg]:size-3';

export const AllAccountsBadge: React.FC = () => (
  <span className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground">
    <InfinityIcon className="h-[15px] w-[15px]" strokeWidth={2.2} />
    All
  </span>
);

const AccountOptionLabel: React.FC<{ name: string }> = ({ name }) => {
  if (name === ALL_ACCOUNTS) return <AllAccountsBadge />;
  if (name === UNASSIGNED) return <span className="text-muted-foreground">No account</span>;
  return <AccountBadge name={name} size="sm" />;
};

interface CommonProps {
  accounts: string[];
  className?: string;
}

interface SingleProps extends CommonProps {
  mode?: 'single';
  value: string | null;
  onChange: (value: string) => void;
  allowAll?: boolean;
  placeholder?: string;
}

interface MultiProps extends CommonProps {
  mode: 'multi';
  /** Empty means "all", matching the query layer. */
  selected: string[];
  onChange: (next: string[]) => void;
}

export type AccountPickerProps = SingleProps | MultiProps;

export function AccountPicker(props: AccountPickerProps) {
  return props.mode === 'multi' ? <MultiPicker {...props} /> : <SinglePicker {...props} />;
}

function SinglePicker({ accounts, value, onChange, allowAll, placeholder, className }: SingleProps) {
  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger data-testid="account-picker-trigger" className={cn(TRIGGER_CLASS, className)}>
        {/* Keeps the badge out of SelectTrigger's `[&>span]:line-clamp-1`, which stacks its icon above the label. */}
        <div className="inline-flex items-center">
          {value ? (
            <AccountOptionLabel name={value} />
          ) : (
            <span className="text-muted-foreground">{placeholder ?? 'Select an account'}</span>
          )}
        </div>
      </SelectTrigger>
      <SelectContent>
        {allowAll && (
          <SelectItem value={ALL_ACCOUNTS}>
            <AllAccountsBadge />
          </SelectItem>
        )}
        {accounts.map((name) => (
          <SelectItem key={name} value={name}>
            <AccountOptionLabel name={name} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MultiPicker({ accounts, selected, onChange, className }: MultiProps) {
  const [open, setOpen] = useState(false);

  const summary = useMemo(() => {
    if (selected.length === 0) return <AllAccountsBadge />;
    if (selected.length === 1) return <AccountOptionLabel name={selected[0]} />;
    return <span className="px-1 text-muted-foreground">{selected.length} accounts</span>;
  }, [selected]);

  const toggle = (name: string): void => {
    onChange(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]);
  };

  return (
    <div className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="account-picker-trigger"
        className={cn(
          'flex items-center justify-between rounded-md border border-input bg-background py-2 pr-3 shadow-sm ring-offset-background',
          TRIGGER_CLASS,
        )}
      >
        <div className="inline-flex items-center">{summary}</div>
        <ChevronDown className="h-4 w-4 opacity-50" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 max-h-72 w-56 overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg">
            <button
              type="button"
              data-testid="account-option-all"
              onClick={() => { onChange([]); setOpen(false); }}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-accent"
            >
              <Check className={cn('h-3.5 w-3.5 shrink-0', selected.length === 0 ? 'opacity-100' : 'opacity-0')} />
              <AllAccountsBadge />
            </button>
            {accounts.map((name) => (
              <button
                key={name}
                type="button"
                data-testid={`account-option-${name}`}
                onClick={() => toggle(name)}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left hover:bg-accent"
              >
                <Check
                  className={cn('h-3.5 w-3.5 shrink-0', selected.includes(name) ? 'opacity-100' : 'opacity-0')}
                />
                <AccountOptionLabel name={name} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

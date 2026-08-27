// The account picker, in one place.
//
// This markup used to exist three times: `ProjectList` and `BrainTab` carried
// hand-copied Radix Selects (BrainTab's comment literally read "Same treatment
// as the Projects page", including a duplicated paragraph explaining the same
// line-clamp workaround), and `UsageDashboard` had an unrelated button row
// with no badges at all. Three looks for one concept.
//
// Single and multi modes share the trigger chrome deliberately. Radix's Select
// cannot do multi-select, so the multi variant is a button + popover — but it
// wears the same classes, the same badges and the same "All" affordance, so
// the two read as one control that happens to accept more than one answer.

import React, { useMemo, useState } from 'react';
import { Check, ChevronDown, Infinity as InfinityIcon } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { AccountBadge } from '@/components/AccountBadge';
import { cn } from '@/lib/utils';

/** Sentinel for "no account filter" in single mode. Not a real account name. */
export const ALL_ACCOUNTS = 'all';

/** Legacy bucket for projects whose account did not resolve. Also not an
 *  account, so it never wears an account badge. */
export const UNASSIGNED = '(unassigned)';

/**
 * Trigger chrome, shared by both modes.
 *
 * `[&>svg]:size-3` keeps the chevron small even though the badge inside makes
 * the trigger taller than bare text would.
 */
const TRIGGER_CLASS = 'h-7 w-auto gap-1.5 pl-1 text-xs [&>svg]:size-3';

/**
 * "All accounts" chip. Matches `AccountBadge size="sm"` in shape — `text-xs`,
 * 15px icon, `px-2 py-0.5`, rounded border — but uses theme-neutral muted
 * tokens, since "All" is not an account and must not borrow any account's
 * colour stack.
 */
export const AllAccountsBadge: React.FC = () => (
  <span className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground">
    <InfinityIcon className="h-[15px] w-[15px]" strokeWidth={2.2} />
    All
  </span>
);

/** One option's visual: a real account gets its badge; the sentinels do not. */
const AccountOptionLabel: React.FC<{ name: string }> = ({ name }) => {
  if (name === ALL_ACCOUNTS) return <AllAccountsBadge />;
  if (name === UNASSIGNED) return <span className="text-muted-foreground">No account</span>;
  return <AccountBadge name={name} size="sm" />;
};

interface CommonProps {
  /** Account names, in display order. */
  accounts: string[];
  className?: string;
}

interface SingleProps extends CommonProps {
  mode?: 'single';
  /** An account name, `ALL_ACCOUNTS`, `UNASSIGNED`, or null for "unset". */
  value: string | null;
  onChange: (value: string) => void;
  /** Offer an explicit "All" option. Off by default — the Brain is scoped to
   *  one vault at a time, so "all accounts" is meaningless there. */
  allowAll?: boolean;
  /** Shown when `value` is null. */
  placeholder?: string;
}

interface MultiProps extends CommonProps {
  mode: 'multi';
  /** Empty means "all", matching the query layer. A filter bar that empties
   *  the view the moment you clear a checkbox reads as a bug. */
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
        {/* The wrapper keeps the badge out of SelectTrigger's
            `[&>span]:line-clamp-1` scope. Inside it, line-clamp forces
            `display: -webkit-box` on the badge span and stacks the icon
            above the label. As a flex child of the trigger it hugs its
            content on the left while the chevron stays right. */}
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
          // Mirrors SelectTrigger's own base classes so the two modes are
          // visually identical; only the primitive underneath differs.
          'flex items-center justify-between rounded-md border border-input bg-background py-2 pr-3 shadow-sm ring-offset-background',
          TRIGGER_CLASS,
        )}
      >
        <div className="inline-flex items-center">{summary}</div>
        <ChevronDown className="h-4 w-4 opacity-50" />
      </button>

      {open && (
        <>
          {/* Click-away layer, under the panel and over everything else. */}
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

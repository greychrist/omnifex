import React, { useEffect, useState } from 'react';
import { useAccounts } from '@/contexts/AccountsContext';
import { useBrainVault } from '@/hooks/useBrainVault';
import { AccountBadge } from '@/components/AccountBadge';
import { SelectComponent } from '@/components/ui/select';
import { BrainVaultSetup } from './BrainVaultSetup';
import { BrainNoteList } from './BrainNoteList';
import { BrainNoteViewer } from './BrainNoteViewer';

/**
 * The Brain tab, scoped to exactly ONE account at a time.
 *
 * Results are never merged across accounts into a single list. Merged-with-
 * badges was considered and rejected during design: it makes cross-account
 * leakage a rendering detail — one bad key, one stale row — rather than an
 * impossibility. Switching vaults is a deliberate act with an explicit
 * control, and everything downstream re-derives from the chosen account.
 */
export const BrainTab: React.FC = () => {
  const { accounts, getColor, getIcon, getAccountType } = useAccounts();
  const vault = useBrainVault();
  const [selectedNote, setSelectedNote] = useState<string | null>(null);

  const { accountId, setAccountId } = vault;

  // Land on an account rather than an empty screen. The FIRST account, not a
  // remembered or resolved one: this app has no "default account" concept, and
  // inventing one here would be exactly the silent fallback the account rules
  // forbid. The user's next act is either accepting it or switching.
  useEffect(() => {
    if (accountId === null && accounts.length > 0) {
      setAccountId(accounts[0].id);
    }
  }, [accounts, accountId, setAccountId]);

  // A note path is only meaningful inside the vault it came from. Carrying a
  // selection across a switch would read a path from one account's list
  // against another account's vault.
  useEffect(() => { setSelectedNote(null); }, [accountId]);

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const status = vault.status;

  const headerSummary = (): string => {
    if (!status) return vault.loading ? 'loading…' : '';
    if (!status.configured) return 'no vault';
    if (status.conflict) return 'unavailable';
    if (!status.exists) return 'vault missing';
    return `${status.noteCount} ${status.noteCount === 1 ? 'note' : 'notes'}`;
  };

  // Anything that stops this account's vault from being browsable routes to the
  // setup panel, which is the only surface that can explain WHY and offer the
  // matching repair.
  const needsSetup =
    status !== null && (!status.configured || !status.exists || status.conflict !== null);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <h2 className="text-sm font-medium">Brain</h2>
        <SelectComponent
          value={accountId === null ? '' : String(accountId)}
          onValueChange={(v) => setAccountId(Number(v))}
          options={accounts.map((a) => ({ value: String(a.id), label: a.name }))}
          placeholder="Select an account"
          className="h-7 w-56 text-xs"
        />
        {account && (
          <AccountBadge
            name={account.name}
            color={getColor(account.name)}
            icon={getIcon(account.name)}
            accountType={getAccountType(account.name)}
            variant="compact"
          />
        )}
        <span className="ml-auto text-xs text-muted-foreground" data-testid="brain-summary">
          {headerSummary()}
        </span>
      </header>

      {vault.error && (
        <div className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {vault.error}
        </div>
      )}

      {needsSetup ? (
        <BrainVaultSetup vault={vault} accountName={account?.name ?? null} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-72 shrink-0 overflow-y-auto border-r">
            <BrainNoteList
              accountId={accountId}
              notes={vault.notes}
              selected={selectedNote}
              onSelect={setSelectedNote}
            />
          </div>
          <div className="min-w-0 flex-1 overflow-y-auto">
            <BrainNoteViewer
              accountId={accountId}
              notePath={selectedNote}
              onNavigate={setSelectedNote}
              onChanged={vault.refresh}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default BrainTab;

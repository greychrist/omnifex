import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAccounts } from '@/contexts/AccountsContext';
import { useBrainVault } from '@/hooks/useBrainVault';
import { AccountPicker } from '@/components/AccountPicker';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BrainVaultSetup } from './BrainVaultSetup';
import { BrainNotesTable } from './BrainNotesTable';
import { BrainNoteViewer } from './BrainNoteViewer';
import { BrainSources } from './BrainSources';
import { BrainStatsPanel } from './BrainStatsPanel';
import { BrainAutomationSettings } from './BrainQueuePanel';
import { SplitHandle } from '@/components/ui/SplitHandle';
import { useSplitWidth } from '@/hooks/useSplitWidth';

type BrainTabName = 'notes' | 'sources' | 'settings';

/**
 * One account at a time. Never merge accounts into one list: that makes
 * cross-account leakage a rendering detail rather than an impossibility.
 */
export const BrainTab: React.FC = () => {
  const { accounts } = useAccounts();
  const vault = useBrainVault();
  const [selectedNote, setSelectedNote] = useState<string | null>(null);

  const { accountId, setAccountId } = vault;

  /** Bumped on vault changes; the stats bar, a sibling, keys its fetch on it. */
  const [statsNonce, setStatsNonce] = useState(0);

  const notesSplitRef = useRef<HTMLDivElement>(null);
  const notesSplit = useSplitWidth({
    storageKey: 'omnifex.brain.notesSplit',
    defaultWidth: 460,
    min: 260,
    minRight: 360,
    containerRef: notesSplitRef,
  });

  const refreshVault = vault.refresh;
  const handleVaultChanged = useCallback(() => {
    setStatsNonce((n) => n + 1);
    void refreshVault();
  }, [refreshVault]);

  // The FIRST account, not a resolved one: no silent default-account fallback.
  useEffect(() => {
    if (accountId === null && accounts.length > 0) {
      setAccountId(accounts[0].id);
    }
  }, [accounts, accountId, setAccountId]);

  // A note path is only meaningful inside the vault it came from.
  useEffect(() => { setSelectedNote(null); }, [accountId]);

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const status = vault.status;

  const [tab, setTab] = useState<BrainTabName>('notes');
  useEffect(() => { setTab('notes'); }, [accountId]);

  const headerSummary = (): string => {
    if (!status) return vault.loading ? 'loading…' : '';
    if (!status.configured) return 'no vault';
    if (status.conflict) return 'unavailable';
    if (!status.exists) return 'vault missing';
    return `${status.noteCount} ${status.noteCount === 1 ? 'note' : 'notes'}`;
  };

  // Unknown is not healthy: status is null during a switch, and treating that
  // as "no setup needed" flashes setup → panes → setup.
  const statusKnown = status !== null;

  const needsSetup =
    status !== null && (!status.configured || !status.exists || status.conflict !== null);

  const indexIsStale = status !== null && status.exists && status.indexedCount !== status.noteCount;

  // Disabled, not hidden: a tab strip that changes length reads as a new page.
  const effectiveTab: BrainTabName = needsSetup ? 'settings' : tab;
  const vaultUnusable = needsSetup;

  return (
    <div className="h-full overflow-hidden">
      <div className="mx-auto flex h-full max-w-6xl flex-col">
        <div className="shrink-0 p-6">
          <h1 className="text-3xl font-bold">Brain</h1>
          <p className="text-body-small mt-1 text-muted-foreground">
            A per-account vault of what you have already worked on, so later
            sessions can recall it instead of being told again.
          </p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
          <Card className="flex min-h-0 flex-1 flex-col p-6">
            <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
              <h2 className="text-heading-4">
                {account ? `${account.name} Brain` : 'Brain'}
                <span className="text-caption ml-2 font-normal text-muted-foreground">
                  (<span data-testid="brain-summary">{headerSummary()}</span>)
                </span>
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Account
                </span>
                <AccountPicker
                  accounts={accounts.map((a) => a.name)}
                  value={account?.name ?? null}
                  onChange={(name) => {
                    const match = accounts.find((a) => a.name === name);
                    if (match) setAccountId(match.id);
                  }}
                />
              </div>
            </div>

            {/* Hidden while unusable: four zeroes read as a fact, not an absence. */}
            {statusKnown && !needsSetup && (
              <BrainStatsPanel
                accountId={accountId}
                nonce={statsNonce}
                className="mb-4 shrink-0 rounded-md border bg-muted/40 px-4 py-2.5 text-xs"
              />
            )}

            {vault.error && (
              <div className="mb-4 shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {vault.error}
              </div>
            )}

            <Tabs
              value={effectiveTab}
              onValueChange={(v) => { setTab(v as BrainTabName); }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <TabsList className="mb-4 shrink-0">
                <TabsTrigger
                  value="notes"
                  disabled={vaultUnusable}
                  title={vaultUnusable ? 'This vault needs setting up first' : undefined}
                >
                  Notes
                </TabsTrigger>
                <TabsTrigger
                  value="sources"
                  disabled={vaultUnusable}
                  title={vaultUnusable ? 'This vault needs setting up first' : undefined}
                >
                  Sources
                </TabsTrigger>
                <TabsTrigger value="settings">
                  Settings
                  {indexIsStale && (
                    <span
                      data-testid="index-stale-dot"
                      title="The search index no longer matches the notes on disk"
                      className="ml-1.5 h-1.5 w-1.5 rounded-full bg-amber-500"
                    />
                  )}
                </TabsTrigger>
              </TabsList>

              {!statusKnown ? (
                // Holds the space so an account switch does not swap the body twice.
                <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
                  {vault.loading ? 'loading…' : null}
                </div>
              ) : (
                <>
                  <TabsContent value="notes" className="mt-0 flex min-h-0 flex-1">
                    <div
                      ref={notesSplitRef}
                      className="flex min-h-0 flex-1 overflow-hidden rounded-md border"
                    >
                      <div
                        className={
                          selectedNote === null
                            ? 'flex min-h-0 flex-1 flex-col'
                            : 'flex min-h-0 shrink-0 flex-col'
                        }
                        style={selectedNote === null ? undefined : { width: notesSplit.width }}
                      >
                        <BrainNotesTable
                          accountId={accountId}
                          notes={vault.notes}
                          selected={selectedNote}
                          onSelect={setSelectedNote}
                        />
                      </div>
                      {selectedNote !== null && (
                        <>
                          <SplitHandle
                            label="Resize the note list"
                            onMouseDown={notesSplit.startResize}
                            onDoubleClick={notesSplit.reset}
                          />
                          <div className="min-w-0 flex-1 overflow-y-auto">
                            <BrainNoteViewer
                              accountId={accountId}
                              notePath={selectedNote}
                              onNavigate={setSelectedNote}
                              onChanged={vault.refresh}
                              onClose={() => { setSelectedNote(null); }}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </TabsContent>

                  <TabsContent value="sources" className="mt-0 flex min-h-0 flex-1">
                    <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border">
                      <BrainSources accountId={accountId} onVaultChanged={handleVaultChanged} />
                    </div>
                  </TabsContent>

                  <TabsContent value="settings" className="mt-0 min-h-0 flex-1 overflow-y-auto">
                    <div className="space-y-6">
                      <BrainVaultSetup vault={vault} accountName={account?.name ?? null} />
                      <BrainAutomationSettings accountId={accountId} />
                    </div>
                  </TabsContent>
                </>
              )}
            </Tabs>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default BrainTab;

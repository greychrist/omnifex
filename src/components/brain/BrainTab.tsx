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
import { InternalArchiveSettings } from '../InternalArchiveSettings';
import { SplitHandle } from '@/components/ui/SplitHandle';
import { useSplitWidth } from '@/hooks/useSplitWidth';

/** The three tabs, and the only state that decides what the card body shows. */
type BrainTabName = 'notes' | 'sources' | 'settings';

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
  const { accounts } = useAccounts();
  const vault = useBrainVault();
  const [selectedNote, setSelectedNote] = useState<string | null>(null);

  const { accountId, setAccountId } = vault;

  /**
   * Bumped whenever a pane below changes the vault, and handed to the stats
   * bar — whose fetch effect keys on it.
   *
   * The bar reads `brain_stats`, which nothing inside Sources can reach: it is
   * a sibling, not a child. Before this the prop was simply never passed, so
   * it defaulted to 0 forever and "Spent indexing" froze at whatever it read
   * on mount. Closing and reopening the tab was the only cure.
   */
  const [statsNonce, setStatsNonce] = useState(0);

  /**
   * The Notes pane's table/viewer split, dragged by the bar between them.
   *
   * The table was a fixed 18rem sidebar, which is too narrow for four columns
   * and unhelpfully wide for a vault of short names — the right width depends
   * on the vault and the window, so it is the user's to choose.
   */
  const notesSplitRef = useRef<HTMLDivElement>(null);
  const notesSplit = useSplitWidth({
    storageKey: 'omnifex.brain.notesSplit',
    defaultWidth: 460,
    min: 260,
    minRight: 360,
    containerRef: notesSplitRef,
  });

  /**
   * Two readings go stale together, so they refresh together: the stats bar,
   * and the vault status behind the header's note count.
   */
  const handleVaultChanged = useCallback(() => {
    setStatsNonce((n) => n + 1);
    void vault.refresh();
  }, [vault.refresh]);

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

  // One value, not a pane plus a `showVault` flag. Vault management used to be
  // a toggle that REPLACED the whole page, so a broken vault hid the account
  // switcher and stranded the user on the account they wanted to leave. As a
  // tab it is just another destination, and setup renders inside it.
  const [tab, setTab] = useState<BrainTabName>('notes');
  useEffect(() => { setTab('notes'); }, [accountId]);

  /** The parenthetical beside the vault's name, the way Projects counts rows. */
  const headerSummary = (): string => {
    if (!status) return vault.loading ? 'loading…' : '';
    if (!status.configured) return 'no vault';
    if (status.conflict) return 'unavailable';
    if (!status.exists) return 'vault missing';
    return `${status.noteCount} ${status.noteCount === 1 ? 'note' : 'notes'}`;
  };

  /**
   * UNKNOWN IS NOT HEALTHY.
   *
   * `useBrainVault` clears `status` to null synchronously on every account
   * switch, deliberately. Both branches below derive from `status`, so during
   * the read neither question — "does this vault need setup?", "how many
   * notes?" — has an answer yet. Treating that gap as "no setup needed" made
   * an unconfigured account render setup → panes → setup on every switch: a
   * visible flash next to the header summary.
   */
  const statusKnown = status !== null;

  // Anything that stops this account's vault from being browsable routes to the
  // setup panel, which is the only surface that can explain WHY and offer the
  // matching repair.
  const needsSetup =
    status !== null && (!status.configured || !status.exists || status.conflict !== null);

  const indexIsStale = status !== null && status.exists && status.indexedCount !== status.noteCount;

  // A vault that cannot be browsed forces the tab that can repair it. Notes and
  // Sources are disabled rather than hidden: a tab strip that changes length
  // depending on vault health reads as a different page every time.
  const effectiveTab: BrainTabName = needsSetup ? 'settings' : tab;
  const vaultUnusable = needsSetup;

  return (
    <div className="h-full overflow-hidden">
      <div className="mx-auto flex h-full max-w-6xl flex-col">
        {/* Hero, matching the Projects page: what this page is, in one line,
            above the surface that does the work. */}
        <div className="shrink-0 p-6">
          <h1 className="text-3xl font-bold">Brain</h1>
          <p className="text-body-small mt-1 text-muted-foreground">
            A per-account vault of what you have already worked on, so later
            sessions can recall it instead of being told again.
          </p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
          <Card className="flex min-h-0 flex-1 flex-col p-6">
            {/* Card header: which vault on the left, which account on the
                right — the same shape as "Recent Projects (12)". */}
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

            {/* What this vault costs and holds, under the name it belongs to.
                Hidden while the vault is unusable — every figure would be zero,
                and four zeroes read as a fact rather than as an absence. */}
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
                  {/* The staleness dot the Vault button used to carry: the
                      index no longer matches the notes on disk, and Settings
                      is where the rebuild lives. */}
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
                // Holds the space while the read is in flight, so switching
                // accounts does not swap the body twice.
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
                      {/* The table takes the whole pane until a note is open —
                          there is nothing to reserve room for, the same rule
                          the Sources pane follows. */}
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
                              // Clearing the selection is what closes it: the
                              // pane is rendered off this value, so the table
                              // takes the whole width back in the same tick.
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
                      {/* Not Brain-specific -- session summarization spends
                          here too -- but this is where OmniFex's own token
                          spend is already discussed, so it is where someone
                          looking for it will look. */}
                      <InternalArchiveSettings />
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

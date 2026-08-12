import React, { useEffect, useState } from 'react';
import { AlertTriangle, FolderPlus, RefreshCw, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, type BrainVaultStatus } from '@/lib/api';
import type { UseBrainVault } from '@/hooks/useBrainVault';
import { logAndForget } from '@/lib/fireAndLog';

interface BrainVaultSetupProps {
  vault: UseBrainVault;
  accountName: string | null;
}

/** True when the FTS index does not reflect what is on disk. */
function indexIsStale(status: BrainVaultStatus): boolean {
  return status.exists && status.indexedCount !== status.noteCount;
}

/**
 * Everything that stands between an account and a browsable vault.
 *
 * Four states, each with exactly the action that fixes it. The important one is
 * CONFLICT: it gets no repair button at all, because a conflict means this
 * path overlaps another account's vault, and the only correct response is a
 * different path. A "retry" there would invite the user to hammer something
 * designed to keep failing.
 */
export const BrainVaultSetup: React.FC<BrainVaultSetupProps> = ({ vault, accountName }) => {
  const [path, setPath] = useState('');
  const [touched, setTouched] = useState(false);
  const status = vault.status;

  // Prefill a suggestion, but never overwrite what the user has typed.
  useEffect(() => {
    if (!accountName || touched) return;
    logAndForget(
      'brain:default-vault-path',
      api.brainDefaultVaultPath(accountName).then((suggested) => {
        setPath((current) => (current === '' ? suggested : current));
      }),
    );
  }, [accountName, touched]);

  if (!status) return null;

  const submit = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    void vault.setVaultPath(trimmed);
  };

  const pathChooser = (label: string): React.ReactElement => (
    <div className="flex items-center gap-2">
      <Input
        value={path}
        onChange={(e) => { setTouched(true); setPath(e.target.value); }}
        placeholder="/absolute/path/to/vault"
        className="max-w-xl font-mono text-xs"
      />
      <Button onClick={() => { submit(path); }} disabled={!path.trim()}>
        <FolderPlus className="mr-1.5 h-4 w-4" />
        {label}
      </Button>
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl space-y-6">
        {status.conflict !== null && (
          <section className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-medium text-destructive">
              <AlertTriangle className="h-4 w-4" />
              This vault is not usable
            </h3>
            <p className="text-xs text-muted-foreground">{status.conflict}</p>
            <p className="text-xs text-muted-foreground">
              Two accounts can never share a vault — that is what keeps one
              account&apos;s memory out of another&apos;s. Choose a different location.
            </p>
            {pathChooser('Use this path')}
          </section>
        )}

        {status.conflict === null && !status.configured && (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">No vault yet</h3>
            <p className="text-xs text-muted-foreground">
              {accountName
                ? `Choose where ${accountName}'s memory lives. It is plain Markdown, so you can open it in Obsidian, back it up, and delete it without touching OmniFex.`
                : 'Choose where this account’s memory lives. It is plain Markdown, openable in Obsidian.'}
            </p>
            {pathChooser('Create vault')}
          </section>
        )}

        {status.conflict === null && status.configured && !status.exists && (
          <section className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              The configured vault no longer exists
            </h3>
            <p className="font-mono text-xs text-muted-foreground">{status.path}</p>
            <p className="text-xs text-muted-foreground">
              It may have been moved, renamed, or deleted. Recreate it here, or point
              this account at wherever it went.
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => { if (status.path) submit(status.path); }}
              >
                Recreate at this path
              </Button>
            </div>
            {pathChooser('Use a different path')}
          </section>
        )}

        {status.conflict === null && status.exists && (
          <section className="space-y-3">
            <h3 className="text-sm font-medium">Vault</h3>
            <p className="font-mono text-xs text-muted-foreground">{status.path}</p>

            {indexIsStale(status) && (
              <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                <p className="text-xs">
                  {status.noteCount} {status.noteCount === 1 ? 'note' : 'notes'} on disk,{' '}
                  {status.indexedCount ?? 'none'} indexed. Search only sees indexed notes.
                </p>
                <Button size="sm" variant="outline" onClick={() => { void vault.rebuild(); }}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  Rebuild index
                </Button>
              </div>
            )}

            {!status.gitAvailable && (
              <p className="text-xs text-amber-500">
                git was not found, so versioning is disabled for this vault. Notes are
                still written and indexed.
              </p>
            )}

            {status.lastGitError !== null && (
              <p className="text-xs text-destructive">
                The last commit failed: {status.lastGitError}
              </p>
            )}

            <Button size="sm" variant="ghost" onClick={() => { void vault.clearVaultPath(); }}>
              <Unlink className="mr-1.5 h-3.5 w-3.5" />
              Disconnect vault
            </Button>
            <p className="text-xs text-muted-foreground">
              Disconnecting only unlinks this account from the folder. Nothing on disk
              is deleted.
            </p>
          </section>
        )}
      </div>
    </div>
  );
};

export default BrainVaultSetup;

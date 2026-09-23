import { useCallback } from 'react';
import type { JSX } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OneShotTerminal } from '@/components/shared/OneShotTerminal';
import { api } from '@/lib/api';

interface ClaudeSignInModalProps {
  open: boolean;
  onClose: () => void;
  /** The account's config dir — the login authenticates exactly this dir. */
  configDir: string;
  accountName?: string;
  /** Fired when `claude auth login` exits cleanly. The modal closes itself. */
  onAuthenticated?: () => void;
}

/**
 * Drives `claude auth login` for one account in a one-shot pty — the in-app
 * equivalent of running `claude-work auth login` in a terminal.
 *
 * Main owns the command and its env (`claude_auth_start_login`), so this
 * never names a binary or passes CLAUDE_CONFIG_DIR itself. Success is the
 * CLI exiting 0; a failure leaves the terminal up so the error stays
 * readable. Closing the dialog unmounts the terminal, which kills the pty.
 */
export function ClaudeSignInModal({
  open,
  onClose,
  configDir,
  accountName,
  onAuthenticated,
}: ClaudeSignInModalProps): JSX.Element {
  const spawn = useCallback(
    (size: { cols: number; rows: number }) => api.startClaudeLoginFlow(configDir, size),
    [configDir],
  );

  const handleExit = (info: { exitCode: number }): void => {
    if (info.exitCode !== 0) return;
    onAuthenticated?.();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-[640px] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>{accountName ? `Sign in to Claude — ${accountName}` : 'Sign in to Claude'}</DialogTitle>
          <DialogDescription>
            Follow the prompts below. The browser opens for sign-in; this window
            closes once the CLI reports success.
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-6 pt-4">
          {open && (
            <div className="h-[360px] rounded-md border border-border bg-background overflow-hidden">
              <OneShotTerminal spawn={spawn} onExit={handleExit} className="h-full w-full" />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

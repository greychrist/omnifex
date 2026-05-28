import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OneShotTerminal } from '@/components/shared/OneShotTerminal';
import { api, type CodexAuthStatus } from '@/lib/api';

/**
 * Modal that drives the `codex login` OAuth flow inside a shared
 * OneShotTerminal pty. Mirrors the pattern in Task 13 — caller controls
 * `open`, we mount the terminal when it flips true, and the dialog
 * tears the pty down when it flips false.
 *
 * Auto-close: when the auth status watcher (Task 14) flips to
 * `authenticated: true`, we fire `onAuthenticated` (if supplied) and
 * call `onClose()` so the parent's `open` state updates without the
 * user having to click anything. Manual close (X or Esc) cancels the
 * in-flight pty so a half-completed login doesn't leak.
 *
 * The codex binary path is resolved up-front via the IPC channel. If
 * the resolver returns `null` the user has no codex install, so we
 * show a fallback message instead of the terminal — better than
 * spawning into a NotFoundError after the modal opens.
 */
interface CodexSignInModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * The Codex account's config dir. Scopes the auth-status subscription so
   * the modal only auto-closes when *this* account finishes signing in, and
   * is threaded into the login flow so the pty authenticates the right
   * account.
   */
  configDir: string;
  /**
   * Optional callback fired when the auth subscription flips to
   * `authenticated: true`. The modal already auto-closes via `onClose`;
   * this is for parents that want a separate side-effect (e.g. resume
   * a queued session start).
   */
  onAuthenticated?: () => void;
}

export function CodexSignInModal({
  open,
  onClose,
  configDir,
  onAuthenticated,
}: CodexSignInModalProps): JSX.Element {
  // Binary path is loaded lazily on open. `null` after a load means "no
  // codex binary"; we render a different body in that case. `undefined`
  // means "haven't loaded yet" — render a loading state.
  const [binary, setBinary] = useState<string | null | undefined>(undefined);
  // ptyHandle is captured by OneShotTerminal's onSpawn-equivalent (we don't
  // expose one — kept here for the cancel call). We capture it via the
  // imperative kill path: OneShotTerminal already kills on unmount, so we
  // only need a separate handle for the explicit "user cancelled" case.
  // Keep a ref to the latest onAuthenticated so the watcher subscription
  // (set up once on open=true) reads the freshest callback if the parent
  // swaps it between renders.
  const onAuthenticatedRef = useRef(onAuthenticated);
  onAuthenticatedRef.current = onAuthenticated;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Load the binary path each time the modal opens. We don't cache it
  // across open/close cycles because the user could install codex while
  // the app is running and we want the next open to pick that up.
  useEffect(() => {
    if (!open) {
      setBinary(undefined);
      return;
    }
    let cancelled = false;
    api.getCodexBinaryPath()
      .then((path) => {
        if (cancelled) return;
        setBinary(path);
      })
      .catch(() => {
        if (cancelled) return;
        setBinary(null);
      });
    return () => { cancelled = true; };
  }, [open]);

  // Subscribe to auth status changes while open. The subscription is the
  // primary signal — `watchPath` in OneShotTerminal is a belt-and-braces
  // backup so the modal still closes if the auth-status broadcast is
  // somehow dropped on a slow box.
  useEffect(() => {
    if (!open) return;
    const unsub = api.subscribeCodexAuthStatus(configDir, (status: CodexAuthStatus) => {
      if (status.authenticated) {
        try { onAuthenticatedRef.current?.(); } catch (err) { console.error(err); }
        onCloseRef.current();
      }
    });
    return unsub;
  }, [open, configDir]);

  // Radix Dialog's `onOpenChange` fires for X-button, Esc, overlay
  // click — all of which should count as "user cancelled the login".
  // OneShotTerminal already kills its pty on unmount, so we just bubble
  // the close up to the parent.
  const handleOpenChange = (next: boolean): void => {
    if (!next) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[640px] p-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Sign in to Codex</DialogTitle>
          <DialogDescription>
            Follow the prompts below to authenticate. This window closes
            automatically once Codex finishes signing you in.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-6 pt-4">
          {binary === undefined ? (
            <div className="h-[320px] flex items-center justify-center text-sm text-muted-foreground">
              Resolving codex binary…
            </div>
          ) : binary === null ? (
            <div className="h-[320px] flex flex-col items-center justify-center text-sm text-muted-foreground gap-2 text-center px-4">
              <p className="font-medium text-foreground">Codex CLI not found.</p>
              <p>
                Install Codex from{' '}
                <a
                  href="https://github.com/openai/codex"
                  className="underline"
                  onClick={(e) => {
                    e.preventDefault();
                    void window.electronAPI.openExternal?.('https://github.com/openai/codex');
                  }}
                >
                  github.com/openai/codex
                </a>
                , then try again.
              </p>
            </div>
          ) : (
            <div className="h-[360px] rounded-md border border-border bg-background overflow-hidden">
              <OneShotTerminal
                binary={binary}
                args={['login']}
                env={{ CODEX_HOME: configDir }}
                watchPath={`${configDir}/auth.json`}
                className="h-full w-full"
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

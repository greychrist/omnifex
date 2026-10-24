import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api, type ClaudeSignInFlow, type ClaudeSignedInAccount } from '@/lib/api';
import { platform } from '@/lib/platform';
import { openSignInLink } from '@/lib/signInBrowser';

interface ClaudeSignInModalProps {
  open: boolean;
  onClose: () => void;
  /** The account's config dir — the sign-in authenticates exactly this dir. */
  configDir: string;
  accountName?: string;
  /** Fired with who the CLI says signed in. The modal closes itself. */
  onAuthenticated?: (account: ClaudeSignedInAccount) => void;
}

type Phase =
  | { kind: 'starting' }
  | { kind: 'ready'; flow: ClaudeSignInFlow }
  | { kind: 'failed'; message: string };

/**
 * Sign one account in to Claude, through the CLI's own OAuth
 * (`claude_authenticate`, run by the daemon in a CLI started for this
 * account — see `electron/services/auth/claude-auth.ts`).
 *
 * On the Mac the sign-in page opens at once, in the browser chosen for this
 * account (`signInBrowser.ts`), and finishes by itself: its redirect lands on
 * the CLI's localhost listener. Anywhere else (the iPad) that listener is out
 * of reach, so the page that shows a code is opened from a button — a popup
 * opened after an await is blocked — and the code is pasted back. The code
 * box is there on the Mac too, for a browser that lands somewhere else.
 *
 * Replaced `claude auth login` in a one-shot terminal (2026-10-24), which
 * could only use the default browser and only ran on the Mac.
 */
export function ClaudeSignInModal({
  open,
  onClose,
  configDir,
  accountName,
  onAuthenticated,
}: ClaudeSignInModalProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  // Read by async callbacks after the dialog may have closed.
  const done = useRef(false);
  const callbacks = useRef({ onAuthenticated, onClose });
  callbacks.current = { onAuthenticated, onClose };

  useEffect(() => {
    if (!open) return;
    let flowId: string | null = null;
    let closed = false;
    done.current = false;
    setPhase({ kind: 'starting' });
    setCode('');
    setCodeError(null);

    const finish = (account: ClaudeSignedInAccount) => {
      if (closed || done.current) return;
      done.current = true;
      callbacks.current.onAuthenticated?.(account);
      callbacks.current.onClose();
    };

    api.claudeSignInBegin(configDir).then((flow) => {
      if (closed) {
        void api.claudeSignInCancel(flow.flowId);
        return;
      }
      flowId = flow.flowId;
      setPhase({ kind: 'ready', flow });
      if (!platform.isDesktop) return;
      void openSignInLink(flow.automaticUrl, configDir);
      api.claudeSignInWait(flow.flowId).then(finish, (err: unknown) => {
        if (closed || done.current) return;
        setPhase({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
      });
    }, (err: unknown) => {
      if (!closed) setPhase({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
    });

    return () => {
      closed = true;
      if (flowId && !done.current) void api.claudeSignInCancel(flowId);
    };
  }, [open, configDir]);

  const submitCode = async (flow: ClaudeSignInFlow) => {
    if (!code.trim()) return;
    setSubmitting(true);
    setCodeError(null);
    try {
      const account = await api.claudeSignInSubmitCode(flow.flowId, code.trim());
      if (done.current) return;
      done.current = true;
      onAuthenticated?.(account);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCodeError(`That code didn't work (${msg}). Copy it again from the sign-in page and paste all of it.`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{accountName ? `Sign in to Claude — ${accountName}` : 'Sign in to Claude'}</DialogTitle>
          <DialogDescription>
            {platform.isDesktop
              ? 'The sign-in page opens in the browser set for this account. This window closes once you finish there.'
              : 'Open the sign-in page, sign in, then paste the code it shows.'}
          </DialogDescription>
        </DialogHeader>

        {phase.kind === 'starting' && (
          <div className="text-sm text-muted-foreground">Starting sign-in…</div>
        )}

        {phase.kind === 'failed' && (
          <div role="alert" className="rounded bg-destructive/5 p-2 text-sm text-destructive break-words">
            {phase.message}
          </div>
        )}

        {phase.kind === 'ready' && (
          <div className="space-y-4">
            {platform.isDesktop ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Waiting for the browser…</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => { void openSignInLink(phase.flow.automaticUrl, configDir); }}
                >
                  Open again
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                onClick={() => { void platform.openExternal(phase.flow.manualUrl); }}
              >
                Open sign-in page
              </Button>
            )}

            <form
              className="space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                void submitCode(phase.flow);
              }}
            >
              <label htmlFor="claude-sign-in-code" className="block text-xs text-muted-foreground">
                {platform.isDesktop ? (
                  <>
                    Or use a code instead:{' '}
                    <button
                      type="button"
                      className="underline hover:text-foreground"
                      onClick={() => { void openSignInLink(phase.flow.manualUrl, configDir); }}
                    >
                      get one
                    </button>
                    , then paste it here.
                  </>
                ) : (
                  'Code'
                )}
              </label>
              <div className="flex gap-2">
                <input
                  id="claude-sign-in-code"
                  aria-label="Code"
                  value={code}
                  onChange={(e) => { setCode(e.target.value); }}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus:border-white/30"
                />
                <Button type="submit" size="sm" disabled={submitting || !code.trim()}>
                  Sign in
                </Button>
              </div>
              {codeError && (
                <div role="alert" className="text-xs text-destructive break-words">{codeError}</div>
              )}
            </form>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

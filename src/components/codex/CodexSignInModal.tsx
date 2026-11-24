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
import type { JSX } from 'react';

interface CodexSignInModalProps {
  open: boolean;
  onClose: () => void;
  configDir: string;
  onAuthenticated?: () => void;
}

export function CodexSignInModal({
  open,
  onClose,
  configDir,
  onAuthenticated,
}: CodexSignInModalProps): JSX.Element {
  const [binary, setBinary] = useState<string | null | undefined>(undefined);
  const onAuthenticatedRef = useRef(onAuthenticated);
  onAuthenticatedRef.current = onAuthenticated;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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

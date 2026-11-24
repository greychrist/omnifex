import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { JsonlNode } from '@/types/jsonl';
import type { SessionStatus } from '@/lib/api';
import { sessionAuthFailure, type SessionAuthFailure } from '@/lib/sessionDerivedState';
import { onAccountSignedIn } from '@/lib/accountSignIn';

/**
 * The transcript outlives the process, so a failure counts only if it landed after this tab last saw its
 * process start. The auto-restart skips a running turn: restarting kills the process.
 */
export function useSessionAuthExpiry(opts: {
  messages: JsonlNode[];
  sessionStatus: SessionStatus;
  turnRunning: boolean;
  configDir: string | null;
  restart: () => Promise<void>;
}): SessionAuthFailure | null {
  const { messages, sessionStatus, turnRunning, configDir, restart } = opts;

  const [processStartedAt, setProcessStartedAt] = useState<number | null>(
    () => (sessionStatus === 'started' ? Date.now() : null),
  );
  useEffect(() => {
    setProcessStartedAt(sessionStatus === 'started' ? Date.now() : null);
  }, [sessionStatus]);

  const failure = useMemo(() => {
    if (processStartedAt === null) return null;
    const found = sessionAuthFailure(messages);
    if (!found || Date.parse(found.at) < processStartedAt) return null;
    return found;
  }, [messages, processStartedAt]);

  const latest = useRef({ failure, turnRunning, restart });
  useLayoutEffect(() => { latest.current = { failure, turnRunning, restart }; });

  useEffect(() => {
    if (!configDir) return undefined;
    return onAccountSignedIn((signedIn) => {
      const { failure: current, turnRunning: running, restart: doRestart } = latest.current;
      if (signedIn !== configDir || !current || running) return;
      void doRestart();
    });
  }, [configDir]);

  return failure;
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { JsonlNode } from '@/types/jsonl';
import type { SessionStatus } from '@/lib/api';
import { sessionAuthFailure, type SessionAuthFailure } from '@/lib/sessionDerivedState';
import { onAccountSignedIn } from '@/lib/accountSignIn';

/**
 * Has this tab's running CLI process lost its sign-in — and if so, restart it
 * the moment its account is signed in again.
 *
 * `sessionAuthFailure` reads the transcript, which outlives the process: a
 * restored or restarted tab replays history that can still end on the
 * failure. So a failure only counts if it landed after this tab last saw its
 * process start. The cost is a false negative when the renderer reattaches to
 * a live process that had already failed; the alternative was a red shield on
 * a working session.
 *
 * The auto-restart skips a turn in flight: restarting kills the process, and
 * the Restart session button stays available for that case.
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

  // Read at event time, so the listener subscribes once per account.
  const latest = useRef({ failure, turnRunning, restart });
  latest.current = { failure, turnRunning, restart };

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

import { useEffect, useState } from 'react';
import { api, type CodexAuthStatus } from '@/lib/api';

export function useCodexAuthStatus(configDir: string | null): CodexAuthStatus | null {
  const [status, setStatus] = useState<CodexAuthStatus | null>(null);

  useEffect(() => {
    if (configDir === null) {
      setStatus(null);
      return;
    }

    let cancelled = false;

    api.getCodexAuthStatus(configDir)
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
      })
      .catch(() => {
        if (cancelled) return;
        // Treat a failed IPC as unauthenticated rather than leaving the consumer on `null` forever.
        setStatus({ authenticated: false });
      });

    const unsub = api.subscribeCodexAuthStatus(configDir, (next) => {
      if (cancelled) return;
      setStatus(next);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [configDir]);

  return status;
}

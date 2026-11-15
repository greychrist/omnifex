import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Display aliases for the repos asked for, keyed by those paths (repos with
 * no alias are absent). An alias belongs to the repo, so an edit made in any
 * repos dialog reaches every tab: the daemon announces `repo-aliases-changed`
 * and this reloads.
 */
export function useRepoAliases(repoPaths: string[]): Record<string, string> {
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const key = repoPaths.join('\0');

  useEffect(() => {
    const paths = key ? key.split('\0') : [];
    if (paths.length === 0) {
      setAliases({});
      return;
    }
    let cancelled = false;
    const load = () => {
      void api.listRepoAliases(paths).catch(() => ({})).then((next) => {
        if (!cancelled) setAliases(next);
      });
    };
    load();
    const off = api.onRepoAliasesChanged(load);
    return () => {
      cancelled = true;
      off();
    };
  }, [key]);

  return aliases;
}

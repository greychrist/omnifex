import { useEffect, useState } from 'react';
import { api, type BranchColor } from '@/lib/api';

export function useRepoBranchPins(repoPaths: string[]): Record<string, Record<string, string>> {
  const [pins, setPins] = useState<Record<string, Record<string, string>>>({});
  const key = repoPaths.join('\0');

  useEffect(() => {
    const paths = key ? key.split('\0') : [];
    let cancelled = false;
    const load = () => {
      void Promise.all(paths.map(async (p) => {
        const rows: BranchColor[] = await api.listBranchColors(p).catch(() => []);
        return [p, Object.fromEntries(rows.map((r) => [r.branch_name, r.color]))] as const;
      })).then((entries) => {
        if (!cancelled) setPins(Object.fromEntries(entries));
      });
    };
    load();
    const off = api.onBranchColorsChanged(() => { load(); });
    return () => {
      cancelled = true;
      off();
    };
  }, [key]);

  return pins;
}

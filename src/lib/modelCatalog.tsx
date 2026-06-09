// Model catalog — the renderer's single source for "which models can I
// pick?". Catalog data originates from the Claude CLI's `initialize`
// handshake: live sessions deliver it via the session store
// (`supportedModels`), pre-session surfaces fetch it per account via
// `api.listSupportedModels` (SQLite-cached in main). `FALLBACK_MODELS` is
// the hardcoded last resort when no catalog is available at all.

import { useEffect, useState } from 'react';
import { Zap } from 'lucide-react';
import { api, type SessionModelInfo } from '@/lib/api';
import type { Model } from '@/components/ModelPicker';

const icon = <Zap className="h-3.5 w-3.5" />;

/** Map a CLI catalog entry to the picker's display shape. */
export function toPickerModel(info: SessionModelInfo): Model {
  const name = info.displayName || info.value;
  return {
    id: info.value,
    name,
    description: info.description ?? '',
    icon,
    shortName: (name[0] ?? '?').toUpperCase(),
    color: 'text-primary',
  };
}

/**
 * Static fallback used when no catalog is available (CLI missing, discovery
 * failed, tests). Mirrors the real CLI catalog as of 2026-06; ids are what
 * the CLI accepts for `--model` / `set_model`.
 */
export const FALLBACK_MODELS: Model[] = [
  { id: 'default', name: 'Default (recommended)', description: "The CLI's recommended model", icon, shortName: 'D', color: 'text-primary' },
  { id: 'claude-fable-5[1m]', name: 'Fable 5', description: 'Most capable for your hardest and longest-running tasks', icon, shortName: 'F', color: 'text-primary' },
  { id: 'sonnet', name: 'Sonnet', description: 'Efficient for routine tasks', icon, shortName: 'S', color: 'text-primary' },
  { id: 'haiku', name: 'Haiku', description: 'Fastest for quick answers', icon, shortName: 'H', color: 'text-primary' },
];

/** Picker list for a raw catalog; falls back when the catalog is empty. */
export function effectiveModels(raw: SessionModelInfo[] | undefined | null): Model[] {
  return raw && raw.length > 0 ? raw.map(toPickerModel) : FALLBACK_MODELS;
}

/** Display name for a model id across raw catalog + fallback. */
export function modelDisplayName(id: string, raw?: SessionModelInfo[] | null): string {
  return (
    raw?.find((m) => m.value === id)?.displayName ??
    FALLBACK_MODELS.find((m) => m.id === id)?.name ??
    id
  );
}

/**
 * Catalog for pre-session surfaces (NewSessionForm, session defaults,
 * account settings). Inert when configDir is undefined — `models` is then
 * the static fallback. The main-process side is SQLite-cached, so repeat
 * calls are cheap; no renderer-side cache needed.
 */
export function useModelCatalog(configDir?: string): {
  models: Model[];
  raw: SessionModelInfo[];
  loading: boolean;
} {
  const [raw, setRaw] = useState<SessionModelInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!configDir) {
      setRaw([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .listSupportedModels(configDir)
      .then((models) => {
        if (!cancelled) setRaw(models ?? []);
      })
      .catch(() => {
        if (!cancelled) setRaw([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [configDir]);

  return { models: effectiveModels(raw), raw, loading };
}

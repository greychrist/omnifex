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
  // CLI descriptions are "·"-separated, detail first ("Opus 4.8 with 1M
  // context · Best for everyday, complex tasks"). The detail segment is the
  // part that identifies the model; keep it, drop the marketing tail.
  const description = (info.description ?? '').split('·')[0].trim();
  return {
    id: info.value,
    name,
    description,
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

/**
 * Relabel the catalog's `default` entry so the picker tells the truth about
 * what "default" actually runs. OmniFex's "default" means "omit `--model` and
 * let the CLI decide", which makes the CLI read the `model` pin from that
 * account's settings.json. So the honest label is "Account Default", and the
 * subtitle is that pinned model's name (resolved through the catalog, then the
 * static fallback for ids the account can't see — e.g. a stale Fable pin).
 * With nothing pinned, the CLI uses its recommended default, so we keep the
 * catalog `default` entry's own description. Returns a new array; non-default
 * entries are passed through by reference.
 */
export function withAccountDefaultLabel(
  models: Model[],
  pinnedModel: string | null | undefined,
  raw?: SessionModelInfo[] | null,
): Model[] {
  const hasPin = !!pinnedModel && pinnedModel !== 'default';
  return models.map((m) => {
    if (m.id !== 'default') return m;
    if (!hasPin) return { ...m, name: 'Account Default' };
    const inCatalog = models.find((x) => x.id === pinnedModel)?.description;
    const description =
      inCatalog && inCatalog.length > 0
        ? inCatalog
        : modelDisplayName(pinnedModel, raw);
    return { ...m, name: 'Account Default', description };
  });
}

// Known model families, longest-first so e.g. nothing shadows a more
// specific keyword. Used to bridge the gap between the picker's alias ids
// (`opus`, `sonnet`) and the concrete ids the CLI stamps on assistant JSONL
// lines (`claude-opus-4-8`) — see pickModelOption.
const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** Extract the model family keyword from any model id/name, or null. */
export function modelFamily(id: string): string | null {
  const lower = id.toLowerCase();
  return MODEL_FAMILIES.find((fam) => lower.includes(fam)) ?? null;
}

/**
 * Resolve the catalog option to display for a given model id. Exact id match
 * wins (the normal alias case, e.g. `opus`). For a concrete CLI id detected
 * from a live TUI session (`claude-opus-4-8`), fall back to the option in the
 * same family so the read-only picker still shows "Opus" rather than the
 * first option. Last resort is the first option.
 */
export function pickModelOption(model: string, models: Model[]): Model {
  const exact = models.find((m) => m.id === model);
  if (exact) return exact;
  const fam = modelFamily(model);
  if (fam) {
    const byFamily = models.find(
      (m) => modelFamily(m.id) === fam || modelFamily(m.name) === fam,
    );
    if (byFamily) return byFamily;
  }
  return models[0];
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
  const [pinnedModel, setPinnedModel] = useState<string | null>(null);

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

  // The account's true "default" is the `model` pin in its settings.json (the
  // CLI reads it when OmniFex omits --model). Read it so the picker can name
  // the real model behind "Account Default" instead of the catalog's generic
  // "recommended" copy. Failure → null → fall back to the recommended label.
  useEffect(() => {
    if (!configDir) {
      setPinnedModel(null);
      return;
    }
    let cancelled = false;
    api
      .getClaudeSettings({ configDir })
      .then((settings) => {
        const m = typeof settings?.model === 'string' ? settings.model : null;
        if (!cancelled) setPinnedModel(m);
      })
      .catch(() => {
        if (!cancelled) setPinnedModel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [configDir]);

  return {
    models: withAccountDefaultLabel(effectiveModels(raw), pinnedModel, raw),
    raw,
    loading,
  };
}

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
 * Marker appended to the model row that "Account Default" resolves to. The
 * default entry used to render as its own extra line — "Account Default
 * (Fable 5)" above a plain "Fable 5" — which said the same thing twice and
 * cost the widest label in a row that has to fit three pickers.
 */
export const ACCOUNT_DEFAULT_MARK = '*';

/**
 * The concrete catalog row a default model id points at: exact id first, then
 * the same family (a live id like `claude-fable-5` vs the catalog's
 * `claude-fable-5[1m]`). Undefined when the account can't see that model —
 * e.g. a stale Fable pin on a non-Fable account.
 */
function concreteTwin(id: string, models: Model[]): Model | undefined {
  const others = models.filter((m) => m.id !== 'default');
  const exact = others.find((m) => m.id === id);
  if (exact) return exact;
  const fam = modelFamily(id);
  if (!fam) return undefined;
  return others.find(
    (m) => modelFamily(m.id) === fam || modelFamily(m.name) === fam,
  );
}

/**
 * Fold the catalog's `default` entry into the model it actually runs.
 *
 * OmniFex's "default" means "omit `--model` and let the CLI decide", which
 * makes the CLI read the `model` pin from that account's settings.json (or,
 * with nothing pinned, its own recommended model). So the entry is labeled
 * with that model's name plus ACCOUNT_DEFAULT_MARK — "Fable 5 *" — and the
 * model's own row is dropped, because it is now that row. The entry keeps the
 * id `default`: picking it still means "omit --model", not "pin this model".
 *
 * `activeDefaultModel` is the concrete id a live session reports (from
 * `get_context_usage` or the last assistant JSONL line) and beats the
 * settings-pin/catalog inference, since it is an observation rather than a
 * guess. When nothing identifies the model at all, the entry keeps the bare
 * "Account Default" label and every row is passed through untouched.
 */
export function withAccountDefaultLabel(
  models: Model[],
  pinnedModel: string | null | undefined,
  raw?: SessionModelInfo[] | null,
  activeDefaultModel?: string | null,
): Model[] {
  const def = models.find((m) => m.id === 'default');
  if (!def) return models;
  const live =
    activeDefaultModel && activeDefaultModel !== 'default' ? activeDefaultModel : null;
  const pin = pinnedModel && pinnedModel !== 'default' ? pinnedModel : null;
  const defaultId = live ?? pin ?? recommendedDefaultModel(raw)?.value ?? null;
  if (!defaultId) {
    return models.map((m) => (m.id === 'default' ? { ...m, name: 'Account Default' } : m));
  }
  const twin = concreteTwin(defaultId, models);
  const name = twin?.name ?? resolveActualModelName(defaultId, models, raw);
  const merged: Model = {
    ...def,
    name: `${name} ${ACCOUNT_DEFAULT_MARK}`,
    // A model the account can't see has no row to borrow a description from,
    // and the recommended model's copy would be a lie there — name it instead.
    description: twin ? twin.description || def.description : name,
  };
  return models.flatMap((m) => {
    if (m.id === 'default') return [merged];
    return m === twin ? [] : [m];
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
 * wins (the normal alias case, e.g. `opus`). For a concrete CLI id
 * (`claude-opus-4-8`), fall back to the option in the same family so the
 * picker still shows "Opus" rather than the first option. Last resort is the
 * first option.
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

/**
 * The real model behind the CLI catalog's `default` entry. The CLI stamps
 * that entry with the recommended model's own description ("Opus 4.8 with 1M
 * context · …"), so an exact description match against the other entries
 * identifies it; failing that, a model-family keyword in the description
 * does. Null when the catalog gives no resolvable default (e.g. the static
 * fallback's generic copy).
 */
export function recommendedDefaultModel(
  raw?: SessionModelInfo[] | null,
): SessionModelInfo | null {
  const def = raw?.find((m) => m.value === 'default');
  if (!def) return null;
  const others = raw!.filter((m) => m.value !== 'default');
  const byDescription = others.find(
    (m) => !!def.description && m.description === def.description,
  );
  if (byDescription) return byDescription;
  const fam = modelFamily(def.description ?? '');
  if (fam) {
    const byFamily = others.find(
      (m) => modelFamily(m.value) === fam || modelFamily(m.displayName) === fam,
    );
    if (byFamily) return byFamily;
  }
  return null;
}

/**
 * Human-readable name derived from a model id alone, for ids no catalog can
 * resolve: strip the `claude-` prefix and any `[1m]` suffix, drop date-stamp
 * segments, capitalize the words, and join version digits with dots —
 * `claude-opus-4-8` → "Opus 4.8", `claude-haiku-4-5-20251001` → "Haiku 4.5".
 * Returns the id untouched when nothing readable remains.
 */
export function prettyModelName(id: string): string {
  const parts = id
    .replace(/\[1m\]$/, '')
    .replace(/^claude-/, '')
    .split('-')
    .filter((p) => p.length > 0 && !/^\d{6,}$/.test(p));
  const words = parts.filter((p) => !/^\d+$/.test(p));
  const version = parts.filter((p) => /^\d+$/.test(p)).join('.');
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  if (!name) return id;
  return version ? `${name} ${version}` : name;
}

/**
 * Human name for the model a session is *actually* running — an alias
 * ('sonnet'), a `[1m]` catalog id, or a concrete CLI id like `claude-fable-5`
 * (from `get_context_usage` / assistant JSONL lines). Exact catalog match
 * first, then a family match against the picker options (excluding the
 * relabeled `default` entry, which would echo its own "Account Default (…)"
 * label back), then the prettified id.
 */
export function resolveActualModelName(
  id: string,
  models: Model[],
  raw?: SessionModelInfo[] | null,
): string {
  const fromRaw = raw?.find((m) => m.value === id)?.displayName;
  if (fromRaw) return fromRaw;
  const fromFallback = FALLBACK_MODELS.find((m) => m.id === id)?.name;
  if (fromFallback) return fromFallback;
  const fam = modelFamily(id);
  if (fam) {
    const byFamily = models.find(
      (m) => m.id !== 'default' && (modelFamily(m.id) === fam || modelFamily(m.name) === fam),
    );
    if (byFamily) return byFamily.name;
  }
  return prettyModelName(id);
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
export function useModelCatalog(
  configDir?: string,
  /** Concrete model id a live session reports; beats the settings pin when
   *  labeling the account-default row. */
  activeDefaultModel?: string | null,
): {
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
    models: withAccountDefaultLabel(effectiveModels(raw), pinnedModel, raw, activeDefaultModel),
    raw,
    loading,
  };
}

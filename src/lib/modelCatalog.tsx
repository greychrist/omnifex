import { useCallback, useEffect, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import { api, type SessionModelInfo } from '@/lib/api';
import { SHIPPED_PRICING } from '@/lib/pricing';
import type { Model } from '@/components/ModelPicker';

const icon = <Zap className="h-3.5 w-3.5" />;

/** Deliberately narrow: only a `(<n>M|K context)` tail goes, never "(recommended)". */
export function stripContextSuffix(name: string): string {
  return name
    .replace(/\s*\(\d+[MK]\s+context\)\s*$/i, '')
    .replace(/\s+with\s+\d+[MK]\s+context\s*$/i, '')
    .trim();
}

/** The CLI's `displayName` is sometimes a bare alias ("Opus (1M context)"); the version is then in the description. */
export function catalogModelName(info: SessionModelInfo): string {
  const display = info.displayName || info.value;
  if (info.value === 'default') return display;
  const base = stripContextSuffix(display);
  if (/\d/.test(base)) return base;
  const detail = stripContextSuffix((info.description ?? '').split('·')[0].trim());
  // A detail like "Best for everyday, complex tasks" must not become the model's name.
  if (/\d/.test(detail) && modelFamily(detail) && modelFamily(detail) === modelFamily(base)) {
    return detail;
  }
  return base;
}

/**
 * The CLI accepts a concrete `--model` id the catalog does not list (verified 2.1.280), so these pin a version.
 * Not verified against the account: one it cannot use fails when the turn runs.
 */
export function extraModelOptions(existing: Model[]): Model[] {
  const taken = new Set(existing.map((m) => stripContextSuffix(m.name.replace(/\s*\*$/, ''))));
  const seen = new Set<string>();
  return SHIPPED_PRICING.flatMap((row) => {
    if (!row.label || taken.has(row.label) || seen.has(row.label)) return [];
    seen.add(row.label);
    return [{
      id: `claude-${row.pattern}`,
      name: row.label,
      description: '',
      icon,
      shortName: (row.label[0] ?? '?').toUpperCase(),
    }];
  });
}

function nameVersion(name: string): number[] | null {
  const match = /(\d+(?:\.\d+)*)/.exec(name);
  return match ? match[1].split('.').map(Number) : null;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function splitLatestModels(models: Model[]): { latest: Model[]; older: Model[] } {
  const bare = (m: Model) => m.name.replace(new RegExp(`\\s*\\${ACCOUNT_DEFAULT_MARK}$`), '');
  const newest = new Map<string, number[]>();
  for (const m of models) {
    const fam = modelFamily(bare(m));
    const version = nameVersion(bare(m));
    if (!fam || !version) continue;
    const best = newest.get(fam);
    if (!best || compareVersions(version, best) > 0) newest.set(fam, version);
  }
  const seen = new Set<string>();
  const latest: Model[] = [];
  const older: Model[] = [];
  for (const m of models) {
    const name = bare(m);
    if (seen.has(name)) continue;
    seen.add(name);
    const fam = modelFamily(name);
    const version = nameVersion(name);
    const best = fam ? newest.get(fam) : undefined;
    const isOlder =
      m.id !== 'default' && !!best && !!version && compareVersions(version, best) < 0;
    (isOlder ? older : latest).push(m);
  }
  return { latest, older };
}

export function toPickerModel(info: SessionModelInfo): Model {
  const name = catalogModelName(info);
  // CLI descriptions are "·"-separated, detail first. When the name came from the detail, show the tail instead.
  const segments = (info.description ?? '').split('·').map((seg) => seg.trim());
  const detail = segments[0] ?? '';
  const description =
    stripContextSuffix(detail) === name && segments.length > 1
      ? segments.slice(1).join(' · ').trim()
      : detail;
  return {
    id: info.value,
    name,
    description,
    icon,
    shortName: (name[0] ?? '?').toUpperCase(),
    ...(info.resolvedModel ? { resolvedId: info.resolvedModel } : {}),
  };
}

export const FALLBACK_MODELS: Model[] = [
  { id: 'default', name: 'Default (recommended)', description: "The CLI's recommended model", icon, shortName: 'D' },
  { id: 'claude-fable-5[1m]', name: 'Fable 5', description: 'Most capable for your hardest and longest-running tasks', icon, shortName: 'F' },
  { id: 'sonnet', name: 'Sonnet', description: 'Efficient for routine tasks', icon, shortName: 'S' },
  { id: 'haiku', name: 'Haiku', description: 'Fastest for quick answers', icon, shortName: 'H' },
];

export function effectiveModels(raw: SessionModelInfo[] | undefined | null): Model[] {
  return raw && raw.length > 0 ? raw.map(toPickerModel) : FALLBACK_MODELS;
}

export const ACCOUNT_DEFAULT_MARK = '*';

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

/** Only a session running ON default says what default is; a pinned session's model is the pick. */
export function liveDefaultEvidence(selectedModel: string, liveModel: string | null | undefined): string | null {
  return selectedModel === 'default' && liveModel ? liveModel : null;
}

/** "default" omits --model, so the CLI runs the account's settings.json `model` pin; picking it never pins. */
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
  // The CLI's catalog label lags the server; reconcile against what ran.
  const twinName = twin ? reconcileLiveModelName(twin, live) : null;
  const name = twinName ?? resolveActualModelName(defaultId, models, raw);
  const merged: Model = {
    ...def,
    name: `${name} ${ACCOUNT_DEFAULT_MARK}`,
    resolvedId: live ?? twin?.resolvedId ?? twin?.id ?? defaultId,
    description: twin ? twin.description || def.description : name,
  };
  return models.flatMap((m) => {
    if (m.id === 'default') return [merged];
    return m === twin ? [] : [m];
  });
}

const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

export function modelFamily(id: string): string | null {
  const lower = id.toLowerCase();
  return MODEL_FAMILIES.find((fam) => lower.includes(fam)) ?? null;
}

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

/** The CLI stamps the `default` entry with the recommended model's own description. */
export function recommendedDefaultModel(
  raw?: SessionModelInfo[] | null,
): SessionModelInfo | null {
  if (!raw) return null;
  const def = raw.find((m) => m.value === 'default');
  if (!def) return null;
  const others = raw.filter((m) => m.value !== 'default');
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

/** A family match is not enough: `opus` matches both opus-5 and opus-5-5, the very lag being fixed. Compare versions. */
export function reconcileLiveModelName(
  row: { id: string; name: string },
  liveId: string | null | undefined,
): string {
  if (!liveId || liveId === 'default') return row.name;
  if (liveId === row.id) return row.name;
  // Already reconciled by withAccountDefaultLabel; doing it again would drop ACCOUNT_DEFAULT_MARK.
  if (row.id === 'default') return row.name;
  // Another family is a pending pick, not a stale label: the previous turn's model stays live until the next runs.
  const fam = modelFamily(row.id) ?? modelFamily(row.name);
  if (fam && modelFamily(liveId) !== fam) return row.name;
  const live = prettyModelName(liveId);
  return live === prettyModelName(row.id) ? row.name : live;
}

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

export function modelPickerLabel(
  id: string,
  raw: SessionModelInfo[] | null | undefined,
  pinnedModel: string | null | undefined,
  activeDefaultModel?: string | null,
): string {
  const models = effectiveModels(raw);
  return (
    withAccountDefaultLabel(models, pinnedModel, raw, activeDefaultModel)
      .find((m) => m.id === id)?.name ??
    models.find((m) => m.id === id)?.name ??
    id
  );
}

export function useModelCatalog(
  configDir?: string,
  activeDefaultModel?: string | null,
  pinRefreshKey = 0,
): {
  models: Model[];
  raw: SessionModelInfo[];
  loading: boolean;
  refresh: () => void;
  refreshing: boolean;
} {
  const [raw, setRaw] = useState<SessionModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshToken = useRef(0);
  useEffect(() => {
    refreshToken.current += 1;
    setRefreshing(false);
  }, [configDir]);

  const refresh = useCallback(() => {
    if (!configDir) return;
    const token = ++refreshToken.current;
    setRefreshing(true);
    api
      .refreshSupportedModels(configDir)
      .then((models) => {
        if (token === refreshToken.current && models && models.length > 0) setRaw(models);
      })
      .catch(() => { /* keep the catalog we had */ })
      .finally(() => {
        if (token === refreshToken.current) setRefreshing(false);
      });
  }, [configDir]);
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
  }, [configDir, pinRefreshKey]);

  return {
    models: withAccountDefaultLabel(effectiveModels(raw), pinnedModel, raw, activeDefaultModel),
    raw,
    loading,
    refresh,
    refreshing,
  };
}

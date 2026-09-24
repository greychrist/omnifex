// Model catalog — the renderer's single source for "which models can I
// pick?". Catalog data originates from the Claude CLI's `initialize`
// handshake: live sessions deliver it via the session store
// (`supportedModels`), pre-session surfaces fetch it per account via
// `api.listSupportedModels` (SQLite-cached in main). `FALLBACK_MODELS` is
// the hardcoded last resort when no catalog is available at all.

import { useEffect, useState } from 'react';
import { Zap } from 'lucide-react';
import { api, type SessionModelInfo } from '@/lib/api';
import { SHIPPED_PRICING } from '@/lib/pricing';
import type { Model } from '@/components/ModelPicker';

const icon = <Zap className="h-3.5 w-3.5" />;

/**
 * Drop a context-window parenthetical from a model name — "Opus 5 (1M
 * context)" → "Opus 5". Every current model is 1M, so the suffix no longer
 * distinguishes anything; it just takes the widest label in a row that has to
 * fit beside two other readouts. Deliberately narrow: only a `(<n>M|K
 * context)` tail goes, never "(recommended)".
 */
export function stripContextSuffix(name: string): string {
  return name
    .replace(/\s*\(\d+[MK]\s+context\)\s*$/i, '')
    .replace(/\s+with\s+\d+[MK]\s+context\s*$/i, '')
    .trim();
}

/**
 * The version-bearing name for a catalog row.
 *
 * The CLI's `displayName` is sometimes a bare alias — the personal account
 * lists `opus[1m]` as "Opus (1M context)", which says nothing about WHICH
 * Opus, while claude.ai offers 5 and 5.5 as separate picks. The version is in
 * the description in that case ("Opus 5.5 with 1M context · …"), so take it
 * from there. The `default` row is left alone: withAccountDefaultLabel owns
 * its name.
 */
export function catalogModelName(info: SessionModelInfo): string {
  const display = info.displayName || info.value;
  if (info.value === 'default') return display;
  const base = stripContextSuffix(display);
  if (/\d/.test(base)) return base;
  const detail = stripContextSuffix((info.description ?? '').split('·')[0].trim());
  // Only borrow a detail that names this same family with a version —
  // "Best for everyday, complex tasks" must not become the model's name.
  if (/\d/.test(detail) && modelFamily(detail) && modelFamily(detail) === modelFamily(base)) {
    return detail;
  }
  return base;
}

/**
 * Models OmniFex knows about that this account's catalog does not list.
 *
 * The CLI publishes one alias per family, and which concrete model that alias
 * resolves to moves underneath it — `opus[1m]` was Opus 5 and is now Opus 5.5.
 * The CLI does accept a concrete id for `--model` regardless of whether it is
 * in the catalog (verified against 2.1.280: `--model claude-opus-5-5` is
 * served by claude-opus-5-5), so these are pickable, and they are the only way
 * to pin a specific version.
 *
 * Sourced from SHIPPED_PRICING because that is already the app's list of
 * models-it-knows, maintained as data — a new model becomes pickable by
 * adding a pricing row, with no release. Rows without a `label` are the
 * generic family fallbacks, not models.
 *
 * These are NOT verified against the account: one the account cannot use
 * fails when the turn runs. That is the accepted cost of the escape hatch.
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
      color: 'text-primary',
    }];
  });
}

/** The dotted version a model name spells ("Opus 5.5" → [5, 5]), or null. */
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

/**
 * Split the picker's list into the newest model of each family — the main
 * list — and every older version, which goes behind "More models".
 *
 * The CLI catalog lists every version an account can use (Opus 5.5, 5, 4.8,
 * 4.7, 4.6 …) as peers, so the pick nearly everyone wants was buried in a
 * list of eleven. The account-default row always stays on the main list, even
 * when it names an older version. A second row with the same name as one
 * already kept is dropped outright: `opus[1m]` resolves to the model the
 * default row already names. Rows with no family or version (the static
 * fallback's "Sonnet", "Account Default") are never moved.
 */
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
    const isOlder =
      m.id !== 'default' && !!fam && !!version && compareVersions(version, newest.get(fam)!) < 0;
    (isOlder ? older : latest).push(m);
  }
  return { latest, older };
}

/** Map a CLI catalog entry to the picker's display shape. */
export function toPickerModel(info: SessionModelInfo): Model {
  const name = catalogModelName(info);
  // CLI descriptions are "·"-separated, detail first ("Opus 4.8 with 1M
  // context · Best for everyday, complex tasks"). The detail segment is the
  // part that identifies the model; keep it, drop the marketing tail —
  // UNLESS the name was taken from that same detail, in which case printing
  // it again beneath the name says one thing twice, and the tail (what the
  // model is FOR) is the useful half.
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
  // `live` is an observation of what ran; the twin is the catalog's guess at
  // what that id is called, and the two disagree whenever the CLI's label is
  // behind the server. Reconcile rather than trusting the label.
  const twinName = twin ? reconcileLiveModelName(twin, live) : null;
  const name = twinName ?? resolveActualModelName(defaultId, models, raw);
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
 * The name to show for a catalog row when the session is running something
 * else under it.
 *
 * The CLI's catalog labels are its own, and they lag: the work account
 * advertises `claude-opus-5[1m]` as "Opus 5 (1M context)" while the server
 * resolves that id to `claude-opus-5-5`, and the personal account's `opus[1m]`
 * alias flipped from Opus 5 to Opus 5.5 underneath the same label. The
 * session card already reports what ran (`sessionControlSummary` reads
 * `liveModel`); this is how the status-bar readout agrees with it.
 *
 * A family match is deliberately NOT enough to call them the same model —
 * `opus` matches both `claude-opus-5` and `claude-opus-5-5`, which is exactly
 * the confusion being fixed. The comparison is on the VERSION each id
 * spells, so a row that names a different version loses to the live id and a
 * row that names the same one keeps its richer label ("Opus 5 (1M context)"
 * says more than "Opus 5").
 */
export function reconcileLiveModelName(
  row: { id: string; name: string },
  liveId: string | null | undefined,
): string {
  if (!liveId || liveId === 'default') return row.name;
  if (liveId === row.id) return row.name;
  // The merged account-default row was already resolved against this same
  // live id by withAccountDefaultLabel, and its name carries
  // ACCOUNT_DEFAULT_MARK. Reconciling it again would rewrite the name and
  // drop the mark.
  if (row.id === 'default') return row.name;
  // Different families are not a stale label, they are a selection the next
  // turn has not used yet: switching the picker mid-session leaves the
  // previous turn's model live until the new one runs. Naming the row after
  // it would misreport what the next turn will use.
  const fam = modelFamily(row.id) ?? modelFamily(row.name);
  if (fam && modelFamily(liveId) !== fam) return row.name;
  const live = prettyModelName(liveId);
  return live === prettyModelName(row.id) ? row.name : live;
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

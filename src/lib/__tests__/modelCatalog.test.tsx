// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import {
  toPickerModel,
  FALLBACK_MODELS,
  effectiveModels,
  modelDisplayName,
  modelFamily,
  pickModelOption,
  resolveActualModelName,
  prettyModelName,
  recommendedDefaultModel,
  withAccountDefaultLabel,
  reconcileLiveModelName,
  stripContextSuffix,
  catalogModelName,
  extraModelOptions,
  splitLatestModels,
  ACCOUNT_DEFAULT_MARK,
  useModelCatalog,
} from '../modelCatalog';
import type { Model } from '@/components/ModelPicker';
import type { SessionModelInfo } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listSupportedModels: vi.fn(),
      getClaudeSettings: vi.fn(),
    },
  };
});

import { api } from '@/lib/api';
const mockedList = vi.mocked(api.listSupportedModels);
const mockedSettings = vi.mocked(api.getClaudeSettings);

beforeEach(() => {
  // Default: account pins no model in settings.json, so "default" keeps the
  // CLI-recommended description. Individual tests override.
  mockedSettings.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  mockedList.mockReset();
  mockedSettings.mockReset();
});

const RAW: SessionModelInfo[] = [
  {
    value: 'claude-fable-5[1m]',
    displayName: 'Fable 5',
    description: 'Most capable',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest' },
];

// A realistic entitled catalog (no Fable) with a "default" entry, mirroring
// what the CLI initialize handshake returns for a non-Fable account.
const CATALOG: SessionModelInfo[] = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks' },
  { value: 'opus[1m]', displayName: 'Opus', description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 4.6 · Efficient for routine tasks' },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
];

describe('toPickerModel', () => {
  it('maps a CLI catalog entry to the picker Model shape', () => {
    const m = toPickerModel(RAW[0]);
    expect(m.id).toBe('claude-fable-5[1m]');
    expect(m.name).toBe('Fable 5');
    expect(m.description).toBe('Most capable');
    expect(m.shortName).toBe('F');
    expect(m.icon).toBeTruthy();
    expect(m.color).toBe('text-primary');
  });

  it('falls back to the value when displayName is missing', () => {
    const m = toPickerModel({ value: 'sonnet', displayName: '', description: '' });
    expect(m.name).toBe('sonnet');
    expect(m.shortName).toBe('S');
  });

  it('uses the purpose tail as the description when the NAME came from the detail', () => {
    // "Sonnet 5 · Efficient for routine tasks" names the model in the detail
    // segment, so the name becomes "Sonnet 5" — printing the detail beneath
    // it as well said the same thing twice.
    const m = toPickerModel({
      value: 'sonnet', displayName: 'Sonnet',
      description: 'Sonnet 5 · Efficient for routine tasks',
    } as SessionModelInfo);
    expect(m.name).toBe('Sonnet 5');
    expect(m.description).toBe('Efficient for routine tasks');
  });

  it('keeps only the detail segment of the description (text before the first ·)', () => {
    const m = toPickerModel({
      value: 'default',
      displayName: 'Default (recommended)',
      description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks',
    });
    expect(m.description).toBe('Opus 4.8 with 1M context');
  });

  it('passes dot-free descriptions through unchanged', () => {
    const m = toPickerModel({ value: 'haiku', displayName: 'Haiku', description: 'Fastest for quick answers' });
    expect(m.description).toBe('Fastest for quick answers');
  });
});

describe('FALLBACK_MODELS', () => {
  it('mirrors the 2026-06 CLI catalog including Fable 5 and the default entry', () => {
    const ids = FALLBACK_MODELS.map((m) => m.id);
    expect(ids).toEqual(['default', 'claude-fable-5[1m]', 'sonnet', 'haiku']);
  });
});

describe('effectiveModels', () => {
  it('maps a non-empty raw catalog', () => {
    const models = effectiveModels(RAW);
    expect(models.map((m) => m.id)).toEqual(['claude-fable-5[1m]', 'haiku']);
  });

  it('returns the fallback for empty/missing catalogs', () => {
    expect(effectiveModels([])).toBe(FALLBACK_MODELS);
    expect(effectiveModels(undefined)).toBe(FALLBACK_MODELS);
    expect(effectiveModels(null)).toBe(FALLBACK_MODELS);
  });
});

describe('modelDisplayName', () => {
  it('prefers the raw catalog displayName', () => {
    expect(modelDisplayName('haiku', RAW)).toBe('Haiku');
  });

  it('falls back to FALLBACK_MODELS, then the raw id', () => {
    expect(modelDisplayName('sonnet')).toBe('Sonnet');
    expect(modelDisplayName('mystery-model')).toBe('mystery-model');
  });
});

describe('modelFamily', () => {
  it('extracts the family keyword from a concrete CLI model id', () => {
    expect(modelFamily('claude-opus-4-8')).toBe('opus');
    expect(modelFamily('claude-sonnet-4-6-20260101')).toBe('sonnet');
    expect(modelFamily('claude-haiku-4-5')).toBe('haiku');
    expect(modelFamily('claude-fable-5[1m]')).toBe('fable');
  });

  it('returns null for ids with no recognizable family (e.g. "default")', () => {
    expect(modelFamily('default')).toBeNull();
    expect(modelFamily('')).toBeNull();
  });
});

describe('pickModelOption', () => {
  const mk = (id: string, name = id): Model => ({
    id, name, description: '', icon: null, shortName: name[0]?.toUpperCase() ?? '?', color: 'text-primary',
  });
  const models = [mk('default', 'Default'), mk('sonnet', 'Sonnet'), mk('opus', 'Opus'), mk('haiku', 'Haiku')];

  it('prefers an exact id match (the common alias case)', () => {
    expect(pickModelOption('opus', models).id).toBe('opus');
    expect(pickModelOption('default', models).id).toBe('default');
  });

  it('falls back to a family match for a concrete CLI id', () => {
    expect(pickModelOption('claude-opus-4-8', models).id).toBe('opus');
    expect(pickModelOption('claude-sonnet-4-6', models).id).toBe('sonnet');
  });

  it('falls back to the first option when nothing matches', () => {
    expect(pickModelOption('gpt-5-codex', models).id).toBe('default');
  });
});

describe('useModelCatalog', () => {
  it('is inert without a configDir (fallback models, no fetch)', () => {
    const { result } = renderHook(() => useModelCatalog(undefined));
    // Same fallback set, but the "default" entry is relabeled "Account Default".
    expect(result.current.models.map((m) => m.id)).toEqual(
      FALLBACK_MODELS.map((m) => m.id),
    );
    expect(result.current.models.find((m) => m.id === 'default')?.name).toBe(
      'Account Default',
    );
    expect(mockedList).not.toHaveBeenCalled();
    expect(mockedSettings).not.toHaveBeenCalled();
  });

  it('fetches the catalog for a configDir and maps it', async () => {
    mockedList.mockResolvedValue(RAW);
    const { result } = renderHook(() => useModelCatalog('/Users/g/.claude-personal'));

    await waitFor(() => {
      expect(result.current.models.map((m) => m.id)).toEqual(['claude-fable-5[1m]', 'haiku']);
    });
    expect(result.current.raw).toEqual(RAW);
    expect(mockedList).toHaveBeenCalledWith('/Users/g/.claude-personal');
  });

  it('falls back when the fetch fails', async () => {
    mockedList.mockRejectedValue(new Error('ipc down'));
    const { result } = renderHook(() => useModelCatalog('/Users/g/.claude-personal'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    // Fallback set is used; only the "default" entry's label changes.
    expect(result.current.models.map((m) => m.id)).toEqual(
      FALLBACK_MODELS.map((m) => m.id),
    );
    expect(result.current.models.find((m) => m.id === 'default')?.name).toBe(
      'Account Default',
    );
  });

  // Rows mapped through toPickerModel now carry the version the CLI puts in
  // the description, so the bare "Opus" alias reads "Opus 4.8".
  it('relabels "default" to the account-pinned model from settings.json', async () => {
    mockedList.mockResolvedValue(CATALOG);
    mockedSettings.mockResolvedValue({ model: 'opus[1m]' });
    const { result } = renderHook(() => useModelCatalog('/Users/g/.claude-personal'));

    await waitFor(() => {
      const def = result.current.models.find((m) => m.id === 'default');
      expect(def?.name).toBe(`Opus 4.8 ${ACCOUNT_DEFAULT_MARK}`);
      // The name already says "Opus 4.8"; the description carries the purpose.
      expect(def?.description).toBe('Best for everyday, complex tasks');
      // One Opus line, not two.
      expect(result.current.models.map((m) => m.id)).toEqual(['default', 'sonnet', 'haiku']);
    });
    expect(mockedSettings).toHaveBeenCalledWith({
      configDir: '/Users/g/.claude-personal',
    });
  });

  it('surfaces an unavailable pin (e.g. Fable) honestly via the fallback name', async () => {
    mockedList.mockResolvedValue(CATALOG);
    mockedSettings.mockResolvedValue({ model: 'claude-fable-5[1m]' });
    const { result } = renderHook(() => useModelCatalog('/Users/g/.claude-personal'));

    await waitFor(() => {
      const def = result.current.models.find((m) => m.id === 'default');
      expect(def?.name).toBe(`Fable 5 ${ACCOUNT_DEFAULT_MARK}`);
      expect(def?.description).toBe('Fable 5');
    });
  });

  it('names the CLI-recommended model when nothing is pinned', async () => {
    mockedList.mockResolvedValue(CATALOG);
    mockedSettings.mockResolvedValue({});
    const { result } = renderHook(() => useModelCatalog('/Users/g/.claude-personal'));

    await waitFor(() => {
      const def = result.current.models.find((m) => m.id === 'default');
      // No pin, but the catalog's default entry identifies the recommended
      // model (opus[1m]) via its shared description — name it.
      expect(def?.name).toBe(`Opus 4.8 ${ACCOUNT_DEFAULT_MARK}`);
      // The name already says "Opus 4.8"; the description carries the purpose.
      expect(def?.description).toBe('Best for everyday, complex tasks');
    });
  });
});

describe('resolveActualModelName', () => {
  it('prefers an exact raw-catalog match', () => {
    expect(resolveActualModelName('claude-fable-5[1m]', FALLBACK_MODELS, RAW)).toBe('Fable 5');
  });

  it('resolves an alias through the static fallback', () => {
    expect(resolveActualModelName('sonnet', FALLBACK_MODELS, null)).toBe('Sonnet');
  });

  it('resolves a concrete CLI id (e.g. from get_context_usage) by family', () => {
    expect(resolveActualModelName('claude-fable-5', FALLBACK_MODELS, null)).toBe('Fable 5');
    expect(resolveActualModelName('claude-sonnet-4-6-20260101', FALLBACK_MODELS, null)).toBe('Sonnet');
  });

  it('never resolves through the relabeled default entry', () => {
    // A catalog whose only "fable" mention is inside the Account Default
    // label must not echo that label back as the model name.
    const models: Model[] = [
      { id: 'default', name: 'Account Default (Fable 5)', description: '', icon: null, shortName: 'D', color: 'text-primary' },
      { id: 'sonnet', name: 'Sonnet', description: '', icon: null, shortName: 'S', color: 'text-primary' },
    ];
    expect(resolveActualModelName('claude-fable-5', models, null)).toBe('Fable 5');
  });

  it('prettifies a concrete CLI id the catalog cannot resolve', () => {
    // FALLBACK_MODELS has no opus entry, so no family match — the raw id
    // must still come out human-readable, not as "claude-opus-4-8".
    expect(resolveActualModelName('claude-opus-4-8', FALLBACK_MODELS, null)).toBe('Opus 4.8');
  });

  it('prettifies unknown ids as a last resort', () => {
    expect(resolveActualModelName('mystery-model', FALLBACK_MODELS, null)).toBe('Mystery Model');
  });
});

describe('prettyModelName', () => {
  it('drops the claude- prefix and dots the version', () => {
    expect(prettyModelName('claude-opus-4-8')).toBe('Opus 4.8');
    expect(prettyModelName('claude-fable-5')).toBe('Fable 5');
  });

  it('drops trailing date stamps', () => {
    expect(prettyModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('strips the [1m] suffix and handles bare aliases', () => {
    expect(prettyModelName('opus[1m]')).toBe('Opus');
    expect(prettyModelName('sonnet')).toBe('Sonnet');
  });

  it('returns the id untouched when nothing readable remains', () => {
    expect(prettyModelName('20260101')).toBe('20260101');
  });
});

describe('recommendedDefaultModel', () => {
  it('matches the default entry to the real model by shared description', () => {
    // The CLI stamps the default entry with the recommended model's own
    // description — in CATALOG that is opus[1m].
    expect(recommendedDefaultModel(CATALOG)?.value).toBe('opus[1m]');
  });

  it('falls back to a family keyword in the default description', () => {
    const catalog: SessionModelInfo[] = [
      { value: 'default', displayName: 'Default (recommended)', description: 'Sonnet 4.6, tuned for speed' },
      { value: 'sonnet', displayName: 'Sonnet', description: 'Efficient for routine tasks' },
    ];
    expect(recommendedDefaultModel(catalog)?.value).toBe('sonnet');
  });

  it('returns null when the catalog gives no resolvable default', () => {
    expect(recommendedDefaultModel(null)).toBeNull();
    expect(recommendedDefaultModel([])).toBeNull();
    expect(recommendedDefaultModel(RAW)).toBeNull(); // no default entry at all
    expect(
      recommendedDefaultModel([
        { value: 'default', displayName: 'Default (recommended)', description: 'The CLI picks' },
        { value: 'haiku', displayName: 'Haiku', description: 'Fastest' },
      ]),
    ).toBeNull();
  });
});

describe('withAccountDefaultLabel', () => {
  const models: Model[] = [
    { id: 'default', name: 'Default (recommended)', description: 'Opus 4.8 with 1M context', icon: null, shortName: 'D', color: 'text-primary' },
    { id: 'opus[1m]', name: 'Opus', description: 'Opus 4.8 with 1M context', icon: null, shortName: 'O', color: 'text-primary' },
    { id: 'sonnet', name: 'Sonnet', description: 'Sonnet 4.6', icon: null, shortName: 'S', color: 'text-primary' },
  ];

  it('renames the default entry to "Account Default" when nothing identifies the model', () => {
    const out = withAccountDefaultLabel(models, null);
    expect(out.find((m) => m.id === 'default')?.name).toBe('Account Default');
    expect(out.map((m) => m.id)).toEqual(models.map((m) => m.id));
  });

  it('marks the recommended model and drops the duplicate row when no model is pinned', () => {
    const out = withAccountDefaultLabel(models, null, CATALOG);
    expect(out.find((m) => m.id === 'default')?.name).toBe(`Opus ${ACCOUNT_DEFAULT_MARK}`);
    // The standalone Opus row is gone — the marked default entry IS that row.
    expect(out.map((m) => m.id)).toEqual(['default', 'sonnet']);
  });

  it('marks the pinned model instead of adding a second line for it', () => {
    const out = withAccountDefaultLabel(models, 'sonnet');
    expect(out.find((m) => m.id === 'default')?.name).toBe(`Sonnet ${ACCOUNT_DEFAULT_MARK}`);
    expect(out.map((m) => m.id)).toEqual(['default', 'opus[1m]']);
  });

  it('keeps the merged entry selectable as "default", not as the concrete id', () => {
    // Picking the marked row must still mean "omit --model and let the CLI
    // read the account's pin" — the merge is a label change, not a pin.
    const out = withAccountDefaultLabel(models, 'sonnet');
    expect(out[0].id).toBe('default');
  });

  it('resolves the pinned name through the raw catalog when provided', () => {
    const raw: SessionModelInfo[] = [
      { value: 'opus[1m]', displayName: 'Opus', description: 'Opus 4.8 with 1M context' },
    ];
    const out = withAccountDefaultLabel(models, 'opus[1m]', raw);
    expect(out.find((m) => m.id === 'default')?.name).toBe(`Opus ${ACCOUNT_DEFAULT_MARK}`);
  });

  it('names a pin missing from the catalog via the static fallback, removing nothing', () => {
    const out = withAccountDefaultLabel(models, 'claude-fable-5[1m]');
    expect(out.find((m) => m.id === 'default')?.name).toBe(`Fable 5 ${ACCOUNT_DEFAULT_MARK}`);
    expect(out.map((m) => m.id)).toEqual(models.map((m) => m.id));
  });

  it('lets an active (live) default model beat the settings pin', () => {
    const out = withAccountDefaultLabel(models, 'sonnet', CATALOG, 'claude-opus-4-8');
    // Named for the version that actually ran, not the `opus[1m]` row's bare
    // "Opus" — the alias says nothing about which Opus, and that ambiguity is
    // what reconcileLiveModelName exists to remove.
    expect(out.find((m) => m.id === 'default')?.name).toBe(`Opus 4.8 ${ACCOUNT_DEFAULT_MARK}`);
    // Opus is still the merged row; Sonnet keeps its own line.
    expect(out.map((m) => m.id)).toEqual(['default', 'sonnet']);
  });

  it('ignores a literal "default" as the active model', () => {
    const out = withAccountDefaultLabel(models, 'sonnet', null, 'default');
    expect(out.find((m) => m.id === 'default')?.name).toBe(`Sonnet ${ACCOUNT_DEFAULT_MARK}`);
  });

  it('leaves non-default, non-merged entries untouched', () => {
    const out = withAccountDefaultLabel(models, 'opus[1m]');
    expect(out.find((m) => m.id === 'sonnet')).toBe(models.find((m) => m.id === 'sonnet'));
  });

  it('takes the merged entry description from the row it replaced', () => {
    const out = withAccountDefaultLabel(models, 'sonnet');
    expect(out.find((m) => m.id === 'default')?.description).toBe('Sonnet 4.6');
  });

  it('falls back to a friendly display name for a pin not in the catalog', () => {
    const out = withAccountDefaultLabel(models, 'claude-fable-5[1m]');
    expect(out.find((m) => m.id === 'default')?.description).toBe('Fable 5');
  });

  it('treats a literal "default" pin as no pin', () => {
    const out = withAccountDefaultLabel(models, 'default', CATALOG);
    // No pin, so the CLI-recommended model (Opus) is what "default" runs.
    expect(out.find((m) => m.id === 'default')?.name).toBe(`Opus ${ACCOUNT_DEFAULT_MARK}`);
  });
});

describe('reconcileLiveModelName', () => {
  const row = { id: 'claude-opus-5[1m]', name: 'Opus 5 (1M context)' };

  it('keeps the catalog name when nothing has run yet', () => {
    expect(reconcileLiveModelName(row, null)).toBe('Opus 5 (1M context)');
    expect(reconcileLiveModelName(row, undefined)).toBe('Opus 5 (1M context)');
    expect(reconcileLiveModelName(row, 'default')).toBe('Opus 5 (1M context)');
  });

  it('keeps the catalog name when the live model IS that row', () => {
    expect(reconcileLiveModelName(row, 'claude-opus-5[1m]')).toBe('Opus 5 (1M context)');
  });

  it('keeps the richer catalog name when the two name the same model', () => {
    // `claude-opus-5` and `claude-opus-5[1m]` are one model; the catalog's
    // name says more (the context window), so it wins.
    expect(reconcileLiveModelName(row, 'claude-opus-5')).toBe('Opus 5 (1M context)');
  });

  it('names the live model when the catalog row is a different version', () => {
    // The real case: the work account advertises `claude-opus-5[1m]` as
    // "Opus 5 (1M context)" and the server runs claude-opus-5-5 for it.
    expect(reconcileLiveModelName(row, 'claude-opus-5-5')).toBe('Opus 5.5');
  });

  it('leaves the merged account-default row alone', () => {
    // withAccountDefaultLabel already resolved that row against the same
    // live id, and its name carries the account-default mark. Reconciling a
    // second time would rewrite the name and drop the mark.
    expect(reconcileLiveModelName({ id: 'default', name: 'Fable 5 *' }, 'claude-fable-5'))
      .toBe('Fable 5 *');
  });

  it('keeps the catalog name when the live model is a different FAMILY', () => {
    // Switching the picker mid-session leaves the previous turn's model as
    // the live one until the next turn lands. Relabeling "Sonnet" as
    // "Opus 5.5" in that window would misreport what the next turn will use.
    expect(reconcileLiveModelName({ id: 'sonnet', name: 'Sonnet' }, 'claude-opus-5-5'))
      .toBe('Sonnet');
  });

  it('resolves a bare alias to the concrete model that ran', () => {
    expect(reconcileLiveModelName({ id: 'opus[1m]', name: 'Opus (1M context)' }, 'claude-opus-5-5'))
      .toBe('Opus 5.5');
    expect(reconcileLiveModelName({ id: 'sonnet', name: 'Sonnet' }, 'claude-sonnet-5'))
      .toBe('Sonnet 5');
  });
});

describe('withAccountDefaultLabel — live model beats a stale catalog label', () => {
  const WORK_RAW: SessionModelInfo[] = [
    { value: 'default', displayName: 'Default (recommended)', description: 'Best for everyday, complex tasks (claude-opus-5[1m])' },
    { value: 'claude-opus-5[1m]', displayName: 'Opus 5 (1M context)', description: 'Best for everyday, complex tasks (claude-opus-5[1m])' },
  ] as SessionModelInfo[];

  it('names the folded default row after the model that actually ran', () => {
    const out = withAccountDefaultLabel(
      effectiveModels(WORK_RAW), null, WORK_RAW, 'claude-opus-5-5',
    );
    expect(out.find((m) => m.id === 'default')?.name).toBe(`Opus 5.5 ${ACCOUNT_DEFAULT_MARK}`);
  });

  it('keeps the catalog label when the live model matches it', () => {
    const out = withAccountDefaultLabel(
      effectiveModels(WORK_RAW), null, WORK_RAW, 'claude-opus-5',
    );
    expect(out.find((m) => m.id === 'default')?.name)
      .toBe(`Opus 5 ${ACCOUNT_DEFAULT_MARK}`);
  });
});

describe('stripContextSuffix', () => {
  it('drops a context-window parenthetical', () => {
    expect(stripContextSuffix('Opus 5 (1M context)')).toBe('Opus 5');
    expect(stripContextSuffix('Opus (1M context)')).toBe('Opus');
    expect(stripContextSuffix('Sonnet (200K context)')).toBe('Sonnet');
    // The CLI also writes it unparenthesised, in descriptions.
    expect(stripContextSuffix('Opus 5.5 with 1M context')).toBe('Opus 5.5');
  });

  it('leaves every other parenthetical alone', () => {
    expect(stripContextSuffix('Default (recommended)')).toBe('Default (recommended)');
    expect(stripContextSuffix('Opus 5.5')).toBe('Opus 5.5');
  });
});

describe('catalogModelName', () => {
  it('keeps a displayName that already names the version', () => {
    expect(catalogModelName({
      value: 'claude-opus-5[1m]', displayName: 'Opus 5 (1M context)',
      description: 'Best for everyday, complex tasks',
    } as SessionModelInfo)).toBe('Opus 5');
  });

  it('takes the version from the description when the name has none', () => {
    // The personal account's `opus[1m]` row: the alias name says nothing
    // about which Opus, and the description is where the CLI puts it.
    expect(catalogModelName({
      value: 'opus[1m]', displayName: 'Opus (1M context)',
      description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks',
    } as SessionModelInfo)).toBe('Opus 5.5');
    expect(catalogModelName({
      value: 'sonnet', displayName: 'Sonnet',
      description: 'Sonnet 5 · Efficient for routine tasks',
    } as SessionModelInfo)).toBe('Sonnet 5');
  });

  it('falls back to the bare name when nothing names a version', () => {
    expect(catalogModelName({
      value: 'haiku', displayName: 'Haiku', description: 'Fastest',
    } as SessionModelInfo)).toBe('Haiku');
  });

  it('never rewrites the default entry', () => {
    expect(catalogModelName({
      value: 'default', displayName: 'Default (recommended)',
      description: 'Opus 5.5 with 1M context · Best for everyday',
    } as SessionModelInfo)).toBe('Default (recommended)');
  });
});

describe('extraModelOptions', () => {
  it('offers every priced model the catalog does not already list', () => {
    const names = extraModelOptions([]).map((m) => m.name);
    expect(names).toContain('Opus 5.5');
    expect(names).toContain('Opus 5');
    expect(names).toContain('Sonnet 5');
    expect(names).toContain('Haiku 4.5');
  });

  it('uses ids the CLI accepts for --model', () => {
    const opus55 = extraModelOptions([]).find((m) => m.name === 'Opus 5.5');
    expect(opus55?.id).toBe('claude-opus-5-5');
  });

  it('drops the ones already on the catalog list, by name', () => {
    const existing: Model[] = [
      { id: 'opus[1m]', name: 'Opus 5.5', description: '', icon: null, shortName: 'O', color: '' },
    ];
    expect(extraModelOptions(existing).map((m) => m.name)).not.toContain('Opus 5.5');
    // A different Opus is still a distinct pick — that is the whole point.
    expect(extraModelOptions(existing).map((m) => m.name)).toContain('Opus 5');
  });
});

describe('splitLatestModels', () => {
  const m = (id: string, name: string): Model => ({ id, name, description: '', icon: null, shortName: name[0], color: '' });
  // The personal account's real 2.1.280 catalog, after withAccountDefaultLabel
  // folded `opus` into the default row.
  const CATALOG = [
    m('default', `Opus 5.5 ${ACCOUNT_DEFAULT_MARK}`),
    m('claude-fable-5-1', 'Fable 5.1'),
    m('sonnet', 'Sonnet 5'),
    m('haiku', 'Haiku 4.5'),
    m('claude-opus-5', 'Opus 5'),
    m('claude-fable-5', 'Fable 5'),
    m('claude-opus-4-8', 'Opus 4.8'),
    m('claude-opus-4-7', 'Opus 4.7'),
    m('claude-opus-4-6', 'Opus 4.6'),
    m('claude-sonnet-4-6', 'Sonnet 4.6'),
    m('opus[1m]', 'Opus 5.5'),
  ];

  it('keeps the newest version of each family on the main list', () => {
    const { latest } = splitLatestModels(CATALOG);
    expect(latest.map((x) => x.id)).toEqual(['default', 'claude-fable-5-1', 'sonnet', 'haiku']);
  });

  it('moves the older versions behind More, in catalog order', () => {
    const { older } = splitLatestModels(CATALOG);
    expect(older.map((x) => x.id)).toEqual([
      'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6',
    ]);
  });

  it('drops a second row that names the same model', () => {
    // `opus[1m]` resolves to the model the default row already names; a
    // second "Opus 5.5" anywhere says one thing twice.
    const { latest, older } = splitLatestModels(CATALOG);
    expect([...latest, ...older].map((x) => x.id)).not.toContain('opus[1m]');
  });

  it('keeps an older account default on the main list beside the newest', () => {
    const { latest, older } = splitLatestModels([
      m('default', `Opus 4.8 ${ACCOUNT_DEFAULT_MARK}`),
      m('opus', 'Opus 5.5'),
      m('claude-opus-5', 'Opus 5'),
    ]);
    expect(latest.map((x) => x.id)).toEqual(['default', 'opus']);
    expect(older.map((x) => x.id)).toEqual(['claude-opus-5']);
  });

  it('leaves rows with no family or version on the main list', () => {
    const { latest, older } = splitLatestModels(FALLBACK_MODELS);
    expect(latest).toEqual(FALLBACK_MODELS);
    expect(older).toEqual([]);
  });
});

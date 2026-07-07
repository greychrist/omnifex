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
  recommendedDefaultModel,
  withAccountDefaultLabel,
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

  it('relabels "default" to the account-pinned model from settings.json', async () => {
    mockedList.mockResolvedValue(CATALOG);
    mockedSettings.mockResolvedValue({ model: 'opus[1m]' });
    const { result } = renderHook(() => useModelCatalog('/Users/g/.claude-personal'));

    await waitFor(() => {
      const def = result.current.models.find((m) => m.id === 'default');
      expect(def?.name).toBe('Account Default (Opus)');
      expect(def?.description).toBe('Opus 4.8 with 1M context');
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
      expect(def?.name).toBe('Account Default (Fable 5)');
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
      expect(def?.name).toBe('Account Default (Opus)');
      expect(def?.description).toBe('Opus 4.8 with 1M context');
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
    expect(resolveActualModelName('claude-fable-5', models, null)).toBe('claude-fable-5');
  });

  it('falls back to the raw id when nothing matches', () => {
    expect(resolveActualModelName('mystery-model', FALLBACK_MODELS, null)).toBe('mystery-model');
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
  });

  it('names the CLI-recommended model with no pin when the raw catalog identifies it', () => {
    const out = withAccountDefaultLabel(models, null, CATALOG);
    expect(out.find((m) => m.id === 'default')?.name).toBe('Account Default (Opus)');
  });

  it('names the pinned model in the label so the picker shows what actually runs', () => {
    const out = withAccountDefaultLabel(models, 'sonnet');
    expect(out.find((m) => m.id === 'default')?.name).toBe('Account Default (Sonnet)');
  });

  it('resolves the pinned name through the raw catalog when provided', () => {
    const raw: SessionModelInfo[] = [
      { value: 'opus[1m]', displayName: 'Opus', description: 'Opus 4.8 with 1M context' },
    ];
    const out = withAccountDefaultLabel(models, 'opus[1m]', raw);
    expect(out.find((m) => m.id === 'default')?.name).toBe('Account Default (Opus)');
  });

  it('names a pin missing from the catalog via the static fallback', () => {
    const out = withAccountDefaultLabel(models, 'claude-fable-5[1m]');
    expect(out.find((m) => m.id === 'default')?.name).toBe('Account Default (Fable 5)');
  });

  it('leaves non-default entries untouched', () => {
    const out = withAccountDefaultLabel(models, 'opus[1m]');
    expect(out.find((m) => m.id === 'opus[1m]')).toEqual(
      models.find((m) => m.id === 'opus[1m]'),
    );
  });

  it('uses the pinned model catalog description when it is in the list', () => {
    const out = withAccountDefaultLabel(models, 'sonnet');
    expect(out.find((m) => m.id === 'default')?.description).toBe('Sonnet 4.6');
  });

  it('falls back to a friendly display name for a pin not in the catalog', () => {
    const out = withAccountDefaultLabel(models, 'claude-fable-5[1m]');
    expect(out.find((m) => m.id === 'default')?.description).toBe('Fable 5');
  });

  it('keeps the recommended description when no model is pinned', () => {
    const out = withAccountDefaultLabel(models, null);
    expect(out.find((m) => m.id === 'default')?.description).toBe('Opus 4.8 with 1M context');
  });

  it('treats a literal "default" pin as no pin', () => {
    const out = withAccountDefaultLabel(models, 'default');
    expect(out.find((m) => m.id === 'default')?.description).toBe('Opus 4.8 with 1M context');
  });
});

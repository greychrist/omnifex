// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import {
  toPickerModel,
  FALLBACK_MODELS,
  effectiveModels,
  modelDisplayName,
  useModelCatalog,
} from '../modelCatalog';
import type { SessionModelInfo } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, listSupportedModels: vi.fn() },
  };
});

import { api } from '@/lib/api';
const mockedList = vi.mocked(api.listSupportedModels);

afterEach(() => {
  cleanup();
  mockedList.mockReset();
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

describe('useModelCatalog', () => {
  it('is inert without a configDir (fallback models, no fetch)', () => {
    const { result } = renderHook(() => useModelCatalog(undefined));
    expect(result.current.models).toBe(FALLBACK_MODELS);
    expect(mockedList).not.toHaveBeenCalled();
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
    expect(result.current.models).toBe(FALLBACK_MODELS);
  });
});

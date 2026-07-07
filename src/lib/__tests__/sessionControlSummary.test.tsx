// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sessionControlSummary } from '../sessionControlSummary';
import { FALLBACK_MODELS } from '../modelCatalog';
import type { SessionModelInfo } from '@/lib/api';

const RAW: SessionModelInfo[] = [
  { value: 'claude-fable-5[1m]', displayName: 'Fable 5', description: 'Most capable' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Efficient' },
];

describe('sessionControlSummary', () => {
  it('resolves an Account Default selection to the pinned model name', () => {
    expect(
      sessionControlSummary({
        model: 'default',
        accountDefaultModel: 'claude-fable-5[1m]',
        models: FALLBACK_MODELS,
        raw: RAW,
        effort: 'high',
        permissionMode: 'auto',
      }),
    ).toBe('Fable 5 | High | Auto Review');
  });

  it('prefers the live model (get_context_usage / JSONL) over the settings pin', () => {
    expect(
      sessionControlSummary({
        model: 'default',
        liveModel: 'claude-fable-5',
        accountDefaultModel: 'sonnet',
        models: FALLBACK_MODELS,
        raw: RAW,
        effort: 'high',
        permissionMode: 'auto',
      }),
    ).toBe('Fable 5 | High | Auto Review');
  });

  it('resolves the live model with no pin at all', () => {
    expect(
      sessionControlSummary({
        model: 'default',
        liveModel: 'claude-fable-5',
        accountDefaultModel: null,
        models: FALLBACK_MODELS,
        raw: RAW,
        effort: 'high',
        permissionMode: 'auto',
      }),
    ).toBe('Fable 5 | High | Auto Review');
  });

  it('resolves via the catalog-recommended model when no pin and no live signal', () => {
    const catalog: SessionModelInfo[] = [
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus 4.8 with 1M context' },
      { value: 'opus[1m]', displayName: 'Opus', description: 'Opus 4.8 with 1M context' },
    ];
    expect(
      sessionControlSummary({
        model: 'default',
        accountDefaultModel: null,
        models: FALLBACK_MODELS,
        raw: catalog,
        effort: 'medium',
        permissionMode: 'acceptEdits',
      }),
    ).toBe('Opus | Medium | Accept Edits');
  });

  it('shows "Default" only as a last resort (no live, no pin, unresolvable catalog)', () => {
    expect(
      sessionControlSummary({
        model: 'default',
        accountDefaultModel: null,
        models: FALLBACK_MODELS,
        raw: RAW, // no default entry — nothing identifies the recommended model
        effort: 'medium',
        permissionMode: 'acceptEdits',
      }),
    ).toBe('Default | Medium | Accept Edits');
  });

  it('treats a literal "default" pin as no pin', () => {
    expect(
      sessionControlSummary({
        model: 'default',
        accountDefaultModel: 'default',
        models: FALLBACK_MODELS,
        raw: RAW,
        effort: 'high',
        permissionMode: 'default',
      }),
    ).toBe('Default | High | Default');
  });

  it('resolves an explicit alias selection through the picker catalog', () => {
    expect(
      sessionControlSummary({
        model: 'sonnet',
        accountDefaultModel: 'claude-fable-5[1m]',
        models: FALLBACK_MODELS,
        raw: RAW,
        effort: 'low',
        permissionMode: 'plan',
      }),
    ).toBe('Sonnet | Low | Plan');
  });

  it('resolves a concrete CLI id (TUI-detected) by model family', () => {
    expect(
      sessionControlSummary({
        model: 'claude-sonnet-4-6-20260101',
        accountDefaultModel: null,
        models: FALLBACK_MODELS,
        raw: RAW,
        effort: 'high',
        permissionMode: 'bypassPermissions',
      }),
    ).toBe('Sonnet | High | Bypass');
  });

  it('maps the legacy "skip" permission alias and falls back for unknown ids', () => {
    expect(
      sessionControlSummary({
        model: 'default',
        accountDefaultModel: null,
        models: FALLBACK_MODELS,
        raw: null,
        effort: 'warp' as never,
        permissionMode: 'skip',
      }),
    ).toBe('Default | warp | Bypass');
  });
});

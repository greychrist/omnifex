import { describe, it, expect, vi } from 'vitest';
import { changeSessionModel } from '../sessionModelChange';
import type { SessionContextUsage } from '@/lib/api';

const USAGE_OPUS: SessionContextUsage = {
  categories: [],
  totalTokens: 28_356,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  percentage: 2.8,
  model: 'claude-opus-4-8[1m]',
};

const USAGE_FABLE: SessionContextUsage = { ...USAGE_OPUS, model: 'claude-fable-5' };

function makeDeps(overrides?: {
  hasLiveSession?: boolean;
  contextUsageResult?: SessionContextUsage | null;
  setModelError?: Error;
}) {
  const calls: string[] = [];
  const deps = {
    tabId: 'tab-1',
    hasLiveSession: overrides?.hasLiveSession ?? true,
    api: {
      sessionSetModel: vi.fn(async () => {
        calls.push('setModel');
        if (overrides?.setModelError) throw overrides.setModelError;
      }),
      sessionContextUsage: vi.fn(async () => {
        calls.push('contextUsage');
        return overrides?.contextUsageResult !== undefined
          ? overrides.contextUsageResult
          : USAGE_FABLE;
      }),
    },
    setSelectedModel: vi.fn(),
    setContextUsage: vi.fn(),
    appendMessage: vi.fn(),
    onError: vi.fn(),
  };
  return { deps, calls };
}

describe('changeSessionModel', () => {
  it('updates the selection immediately, before any IPC resolves', async () => {
    const { deps } = makeDeps();
    const promise = changeSessionModel('claude-fable-5[1m]', deps);
    expect(deps.setSelectedModel).toHaveBeenCalledWith('claude-fable-5[1m]');
    await promise;
  });

  it('refreshes context usage after the CLI confirms the switch, so the stale live model cannot win in the header summary', async () => {
    // Regression: changing model mid-session updated the picker but left
    // contextUsage.model at the init-time model — sessionControlSummary
    // prefers the live signal, so the header kept naming the old model
    // until the next turn's result. The set_model → get_context_usage
    // round-trip returns the new model immediately (verified against
    // CLI 2.1.217), so a refresh on confirm fixes the summary.
    const { deps, calls } = makeDeps();
    await changeSessionModel('claude-fable-5[1m]', deps);
    expect(deps.api.sessionSetModel).toHaveBeenCalledWith('tab-1', 'claude-fable-5[1m]');
    expect(deps.setContextUsage).toHaveBeenCalledWith(USAGE_FABLE);
    // Refresh must come after the CLI applied the model, not race it.
    expect(calls).toEqual(['setModel', 'contextUsage']);
  });

  it('appends a control-change transcript marker on a live session', async () => {
    const { deps } = makeDeps();
    await changeSessionModel('sonnet', deps);
    expect(deps.appendMessage).toHaveBeenCalledTimes(1);
    const node = deps.appendMessage.mock.calls[0][0];
    expect(node).toMatchObject({ kind: 'control-change', control: 'model', value: 'sonnet' });
  });

  it('does not touch the CLI or context usage without a live session', async () => {
    const { deps } = makeDeps({ hasLiveSession: false });
    await changeSessionModel('sonnet', deps);
    expect(deps.setSelectedModel).toHaveBeenCalledWith('sonnet');
    expect(deps.api.sessionSetModel).not.toHaveBeenCalled();
    expect(deps.api.sessionContextUsage).not.toHaveBeenCalled();
    expect(deps.appendMessage).not.toHaveBeenCalled();
  });

  it('keeps the stale usage rather than clearing it when the refresh returns null', async () => {
    const { deps } = makeDeps({ contextUsageResult: null });
    await changeSessionModel('sonnet', deps);
    expect(deps.setContextUsage).not.toHaveBeenCalled();
  });

  it('routes failures to onError instead of throwing', async () => {
    const boom = new Error('engine gone');
    const { deps } = makeDeps({ setModelError: boom });
    await changeSessionModel('sonnet', deps);
    expect(deps.onError).toHaveBeenCalledWith(boom);
    expect(deps.setContextUsage).not.toHaveBeenCalled();
  });
});

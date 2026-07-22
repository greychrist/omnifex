import { describe, it, expect, vi } from 'vitest';
import { changeSessionModel, mirrorControlState } from '../sessionModelChange';
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

describe('mirrorControlState', () => {
  function makeMirrorDeps(prev: SessionContextUsage | null = USAGE_OPUS) {
    let usage = prev;
    return {
      setSelectedModel: vi.fn(),
      setPermissionMode: vi.fn(),
      setEffort: vi.fn(),
      setContextUsage: vi.fn(
        (updater: SessionContextUsage | null | ((p: SessionContextUsage | null) => SessionContextUsage | null)) => {
          usage = typeof updater === 'function' ? updater(usage) : updater;
        },
      ),
      readUsage: () => usage,
    };
  }

  it('mirrors a detected model into the selection and patches the stale live usage model', () => {
    // Same staleness class as the picker path, TUI flavor: /model in the
    // terminal fires session-control-state, but a contextUsage snapshot
    // left over from a rich-mode stint still names the old model and wins
    // in the header summary. No engine exists in TUI mode to refetch, so
    // the detected model is patched onto the snapshot directly.
    const deps = makeMirrorDeps();
    mirrorControlState({ model: 'claude-fable-5' }, deps);
    expect(deps.setSelectedModel).toHaveBeenCalledWith('claude-fable-5');
    expect(deps.readUsage()?.model).toBe('claude-fable-5');
    // Token figures are untouched — only the model name is known to change.
    expect(deps.readUsage()?.totalTokens).toBe(USAGE_OPUS.totalTokens);
  });

  it('leaves a null usage null (nothing to patch on a TUI cold start)', () => {
    const deps = makeMirrorDeps(null);
    mirrorControlState({ model: 'claude-fable-5' }, deps);
    expect(deps.setSelectedModel).toHaveBeenCalledWith('claude-fable-5');
    expect(deps.readUsage()).toBeNull();
  });

  it('mirrors permission mode', () => {
    const deps = makeMirrorDeps();
    mirrorControlState({ permissionMode: 'acceptEdits' }, deps);
    expect(deps.setPermissionMode).toHaveBeenCalledWith('acceptEdits');
    expect(deps.setSelectedModel).not.toHaveBeenCalled();
  });

  it('mirrors a detected effort level', () => {
    // CLI ≥2.1.212 stamps `effort` on assistant JSONL lines, so TUI-mode
    // effort changes (`/effort` etc. in the terminal) are now detectable —
    // the old "never reaches the JSONL" limitation is gone.
    const deps = makeMirrorDeps();
    mirrorControlState({ effort: 'max' }, deps);
    expect(deps.setEffort).toHaveBeenCalledWith('max');
    expect(deps.setSelectedModel).not.toHaveBeenCalled();
  });

  it('ignores effort values outside the known EffortLevel set', () => {
    // A future CLI value must not be pushed into the typed picker state.
    const deps = makeMirrorDeps();
    mirrorControlState({ effort: 'ultracode' }, deps);
    expect(deps.setEffort).not.toHaveBeenCalled();
  });

  it('ignores empty and missing fields', () => {
    const deps = makeMirrorDeps();
    mirrorControlState({ model: '', permissionMode: '', effort: '' }, deps);
    mirrorControlState(undefined, deps);
    expect(deps.setSelectedModel).not.toHaveBeenCalled();
    expect(deps.setPermissionMode).not.toHaveBeenCalled();
    expect(deps.setEffort).not.toHaveBeenCalled();
    expect(deps.readUsage()?.model).toBe(USAGE_OPUS.model);
  });
});

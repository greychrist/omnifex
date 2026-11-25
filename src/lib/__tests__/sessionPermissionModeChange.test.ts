import { describe, it, expect, vi } from 'vitest';
import { changeSessionPermissionMode } from '../sessionPermissionModeChange';

function makeDeps(overrides?: { hasLiveSession?: boolean; error?: Error; applied?: string | null }) {
  return {
    tabId: 'tab-1',
    hasLiveSession: overrides?.hasLiveSession ?? true,
    previous: 'acceptEdits',
    api: {
      sessionSetPermissionMode: vi.fn(async (): Promise<string | null> => {
        if (overrides?.error) throw overrides.error;
        return overrides?.applied ?? null;
      }),
    },
    setPermissionMode: vi.fn(),
    appendMessage: vi.fn(),
    onError: vi.fn(),
  };
}

describe('changeSessionPermissionMode', () => {
  it('sets the picker and pushes the mode to a live session, marking the transcript', async () => {
    const deps = makeDeps();
    await changeSessionPermissionMode('plan', deps);
    expect(deps.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(deps.api.sessionSetPermissionMode).toHaveBeenCalledWith('tab-1', 'plan');
    expect(deps.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'control-change', control: 'permission', value: 'plan' }),
    );
    expect(deps.onError).not.toHaveBeenCalled();
  });

  it('only sets the picker before a session runs — the next launch uses it', async () => {
    const deps = makeDeps({ hasLiveSession: false });
    await changeSessionPermissionMode('bypassPermissions', deps);
    expect(deps.setPermissionMode).toHaveBeenCalledWith('bypassPermissions');
    expect(deps.api.sessionSetPermissionMode).not.toHaveBeenCalled();
  });

  it('rolls the picker back and reports the refusal, with no transcript marker', async () => {
    const error = new Error('Bypass is only available in a session started in Bypass.');
    const deps = makeDeps({ error });
    await changeSessionPermissionMode('bypassPermissions', deps);
    expect(deps.setPermissionMode.mock.calls).toEqual([['bypassPermissions'], ['acceptEdits']]);
    expect(deps.appendMessage).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith(error);
  });

  it('moves the picker to the mode the CLI says is in effect, and marks that one', async () => {
    const deps = makeDeps({ applied: 'plan' });
    await changeSessionPermissionMode('acceptEdits', deps);
    expect(deps.setPermissionMode.mock.calls).toEqual([['acceptEdits'], ['plan']]);
    expect(deps.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'control-change', control: 'permission', value: 'plan' }),
    );
  });

  it('leaves the picker alone when the CLI confirms the requested mode', async () => {
    const deps = makeDeps({ applied: 'plan' });
    await changeSessionPermissionMode('plan', deps);
    expect(deps.setPermissionMode.mock.calls).toEqual([['plan']]);
  });
});

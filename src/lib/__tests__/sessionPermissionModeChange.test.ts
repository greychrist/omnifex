import { describe, it, expect, vi } from 'vitest';
import { changeSessionPermissionMode } from '../sessionPermissionModeChange';

function makeDeps(overrides?: { hasLiveSession?: boolean; error?: Error }) {
  return {
    tabId: 'tab-1',
    hasLiveSession: overrides?.hasLiveSession ?? true,
    previous: 'acceptEdits',
    api: {
      sessionSetPermissionMode: vi.fn(async () => {
        if (overrides?.error) throw overrides.error;
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

  // Main has already rolled its copy back. A picker left on the refused mode
  // is how Bypass used to look applied while the CLI ran on in the old mode.
  it('rolls the picker back and reports the refusal, with no transcript marker', async () => {
    const error = new Error('Bypass is only available in a session started in Bypass.');
    const deps = makeDeps({ error });
    await changeSessionPermissionMode('bypassPermissions', deps);
    expect(deps.setPermissionMode.mock.calls).toEqual([['bypassPermissions'], ['acceptEdits']]);
    expect(deps.appendMessage).not.toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith(error);
  });
});

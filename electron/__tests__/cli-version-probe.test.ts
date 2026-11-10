import { describe, it, expect, vi } from 'vitest';
import { createCliVersionProbe } from '../services/cli-version-probe';

describe('createCliVersionProbe', () => {
  function setup(initial: { path: string | null; fingerprint: string | null; version: string }) {
    const state = { ...initial };
    const run = vi.fn(() => `${state.version} (Claude Code)\n`);
    const probe = createCliVersionProbe({
      resolveBinary: () => state.path,
      fingerprint: () => state.fingerprint,
      run,
    });
    return { state, run, probe };
  }

  it('runs --version once while the binary is unchanged', () => {
    const { run, probe } = setup({ path: '/bin/claude', fingerprint: 'v1', version: '2.1.321' });
    expect(probe()).toBe('2.1.321 (Claude Code)');
    expect(probe()).toBe('2.1.321 (Claude Code)');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('/bin/claude');
  });

  it('re-probes when the CLI updates in place under a running daemon', () => {
    const { state, run, probe } = setup({ path: '/bin/claude', fingerprint: 'v1', version: '2.1.321' });
    expect(probe()).toBe('2.1.321 (Claude Code)');
    state.fingerprint = 'v2';
    state.version = '2.1.322';
    expect(probe()).toBe('2.1.322 (Claude Code)');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('re-probes when the resolved binary changes (Settings picked another)', () => {
    const { state, run, probe } = setup({ path: '/bin/claude', fingerprint: 'v1', version: '2.1.321' });
    probe();
    state.path = '/opt/claude';
    probe();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('no binary → null without running anything', () => {
    const { run, probe } = setup({ path: null, fingerprint: null, version: 'x' });
    expect(probe()).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('a failed probe degrades to null and is retried only after the binary changes', () => {
    const { state, run, probe } = setup({ path: '/bin/claude', fingerprint: 'v1', version: '2.1.321' });
    run.mockImplementationOnce(() => { throw new Error('ENOENT'); });
    expect(probe()).toBeNull();
    expect(probe()).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    state.fingerprint = 'v2';
    expect(probe()).toBe('2.1.321 (Claude Code)');
  });

  it('an unstattable binary is re-probed on every call rather than cached forever', () => {
    const { run, probe } = setup({ path: '/bin/claude', fingerprint: null, version: '2.1.321' });
    probe();
    probe();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

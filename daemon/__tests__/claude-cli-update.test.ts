import { describe, it, expect, vi } from 'vitest';
import { createClaudeCliReviewService } from '../services/claude-cli-review';

function recordingRunner(impl?: (configDir: string) => Promise<string>) {
  const calls: string[] = [];
  const fn = vi.fn(async (configDir: string) => {
    calls.push(configDir);
    return (await impl?.(configDir)) ?? 'up to date';
  });
  return { calls, fn };
}

const account = (name: string, configDir: string) => ({ name, configDir });

describe('createClaudeCliReviewService — runUpdate', () => {
  it('runs the CLI updater once per Claude account, in order', async () => {
    const runner = recordingRunner();
    const service = createClaudeCliReviewService({
      cliVersionFn: () => '2.1.252 (Claude Code)',
      claudeAccountsFn: () => [
        account('Personal', '/home/g/.claude-personal'),
        account('Work', '/home/g/.claude-work'),
      ],
      runUpdateFn: runner.fn,
    });

    const result = await service.runUpdate();

    expect(runner.calls).toEqual([
      '/home/g/.claude-personal',
      '/home/g/.claude-work',
    ]);
    expect(result.accounts.map((a) => a.account)).toEqual(['Personal', 'Work']);
    expect(result.accounts.every((a) => a.ok)).toBe(true);
  });

  it('serialises the runs rather than firing them together', async () => {
    // The CLI's update lock is per-machine, not per-config-dir.
    let inFlight = 0;
    let maxInFlight = 0;
    const runner = recordingRunner(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return 'ok';
    });

    await createClaudeCliReviewService({
      cliVersionFn: () => '2.1.252',
      claudeAccountsFn: () => [
        account('A', '/a'),
        account('B', '/b'),
        account('C', '/c'),
      ],
      runUpdateFn: runner.fn,
    }).runUpdate();

    expect(maxInFlight).toBe(1);
  });

  it('keeps going when one account fails, and reports which', async () => {
    const runner = recordingRunner(async (configDir) => {
      if (configDir === '/b') throw new Error('npm folder not writable');
      return 'ok';
    });

    const result = await createClaudeCliReviewService({
      cliVersionFn: () => '2.1.252',
      claudeAccountsFn: () => [
        account('A', '/a'),
        account('B', '/b'),
        account('C', '/c'),
      ],
      runUpdateFn: runner.fn,
    }).runUpdate();

    expect(runner.calls).toEqual(['/a', '/b', '/c']);
    expect(result.accounts).toEqual([
      { account: 'A', ok: true, message: 'ok' },
      { account: 'B', ok: false, message: 'npm folder not writable' },
      { account: 'C', ok: true, message: 'ok' },
    ]);
  });

  it('reports the version move by re-probing after the runs', async () => {
    const versions = ['2.1.252 (Claude Code)', '2.1.257 (Claude Code)'];
    let probe = 0;
    const result = await createClaudeCliReviewService({
      cliVersionFn: () => versions[Math.min(probe++, versions.length - 1)],
      claudeAccountsFn: () => [account('Personal', '/p')],
      runUpdateFn: recordingRunner().fn,
    }).runUpdate();

    expect(result.from).toBe('2.1.252');
    expect(result.to).toBe('2.1.257');
    expect(result.upgraded).toBe(true);
  });

  it('reports upgraded=false when the version did not move', async () => {
    const result = await createClaudeCliReviewService({
      cliVersionFn: () => '2.1.257 (Claude Code)',
      claudeAccountsFn: () => [account('Personal', '/p')],
      runUpdateFn: recordingRunner().fn,
    }).runUpdate();

    expect(result.from).toBe('2.1.257');
    expect(result.to).toBe('2.1.257');
    expect(result.upgraded).toBe(false);
  });

  it('spawns nothing when there are no Claude accounts', async () => {
    const runner = recordingRunner();
    const result = await createClaudeCliReviewService({
      cliVersionFn: () => '2.1.252',
      claudeAccountsFn: () => [],
      runUpdateFn: runner.fn,
    }).runUpdate();

    expect(runner.fn).not.toHaveBeenCalled();
    expect(result.accounts).toEqual([]);
    expect(result.upgraded).toBe(false);
  });

  it('throws when accounts exist but no runner was wired', async () => {
    const service = createClaudeCliReviewService({
      cliVersionFn: () => '2.1.252',
      claudeAccountsFn: () => [account('Personal', '/p')],
    });

    await expect(service.runUpdate()).rejects.toThrow(/runUpdateFn/);
  });

  it('surfaces a non-Error rejection as text rather than "[object Object]"', async () => {
    const result = await createClaudeCliReviewService({
      cliVersionFn: () => '2.1.252',
      claudeAccountsFn: () => [account('Personal', '/p')],
      runUpdateFn: vi.fn().mockRejectedValue('exit code 1'),
    }).runUpdate();

    expect(result.accounts[0]).toEqual({
      account: 'Personal',
      ok: false,
      message: 'exit code 1',
    });
  });

  it('still reports account results when the binary cannot be probed', async () => {
    const result = await createClaudeCliReviewService({
      cliVersionFn: () => null,
      claudeAccountsFn: () => [account('Personal', '/p')],
      runUpdateFn: recordingRunner().fn,
    }).runUpdate();

    expect(result.from).toBeNull();
    expect(result.to).toBeNull();
    expect(result.upgraded).toBe(false);
    expect(result.accounts[0].ok).toBe(true);
  });
});

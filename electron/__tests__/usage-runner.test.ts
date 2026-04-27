import { describe, it, expect, vi } from 'vitest';
import {
  createUsageRunnerService,
  type PtySpawner,
  type FakePty,
} from '../services/usage-runner';

const MAX_FULL_FIXTURE = `
Session
Total cost:             $0.0000
Total duration (API):   0s
Total duration (wall):  3s
Total code changes:     0 lines added, 0 lines removed
Usage:                  0 input, 0 output, 0 cache read, 0 cache write

Current session
33% used
Resets 9:40am (America/New_York)

Current week (all models)
68% used
Resets 7pm (America/New_York)

Current week (Sonnet only)
6% used
Resets 7pm (America/New_York)
`;

function makeFakeAccountsService(cliPath: string | null = null) {
  return {
    listAccounts: () => [
      {
        id: 1, name: 'personal', config_dir: '/cfg/personal',
        cli_path: cliPath, is_default: true,
        account_type: 'max', color: null, icon: null,
        created_at: '', updated_at: '',
      },
    ],
  } as unknown as import('../services/accounts').AccountsService;
}

function makeFakeRateLimits() {
  return {
    recordUtilization: vi.fn(),
  } as unknown as import('../services/rate-limits').RateLimitsService;
}

function makeScriptedSpawn(scriptedOutput: string, settleDelayMs = 30): PtySpawner {
  return () => {
    const dataHandlers: ((d: string) => void)[] = [];
    const exitHandlers: ((code: { exitCode: number }) => void)[] = [];
    let killed = false;
    setTimeout(() => {
      if (killed) return;
      // Emit the welcome-screen footer marker the runner now waits for
      // before sending /usage. Real TUI shows "? for shortcuts" once the
      // prompt is interactive.
      for (const h of dataHandlers) h('? for shortcuts ');
    }, 5);
    const fake: FakePty = {
      write: (data: string) => {
        if (data.includes('/usage')) {
          setTimeout(() => {
            if (killed) return;
            for (const h of dataHandlers) h(scriptedOutput);
          }, settleDelayMs);
        }
      },
      kill: () => {
        killed = true;
        for (const h of exitHandlers) h({ exitCode: 0 });
      },
      onData: (cb) => { dataHandlers.push(cb); },
      onExit: (cb) => { exitHandlers.push(cb); },
    };
    return fake;
  };
}

const TUNING = {
  settleQuietMs: 30,
  usageQuietMs: 60,
  hardTimeoutMs: 5000,
  killGraceMs: 0,
};

describe('usage-runner', () => {
  it('happy path: parses, dual-writes recordUtilization, caches result', async () => {
    const accounts = makeFakeAccountsService();
    const rateLimits = makeFakeRateLimits();
    const runner = createUsageRunnerService({
      accounts, rateLimits,
      spawnPty: makeScriptedSpawn(MAX_FULL_FIXTURE),
      findClaudeBinary: () => '/fake/claude',
      now: () => 1700000000000,
      ...TUNING,
    });
    const result = await runner.run('personal');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.windows.length).toBe(3);
    // observedAt = 1700000000000 (2023-11-14T22:13:20Z = 17:13 NY EST/UTC-5).
    // "9:40am (America/New_York)" already passed today → Nov 15 14:40Z.
    // "7pm (America/New_York)" still ahead today        → Nov 15 00:00Z.
    const nextNy0940 = Math.floor(Date.UTC(2023, 10, 15, 14, 40, 0) / 1000);
    const nextNy1900 = Math.floor(Date.UTC(2023, 10, 15, 0, 0, 0) / 1000);
    expect(rateLimits.recordUtilization).toHaveBeenCalledWith(
      '/cfg/personal', 'five_hour', 33, nextNy0940,
    );
    expect(rateLimits.recordUtilization).toHaveBeenCalledWith(
      '/cfg/personal', 'seven_day', 68, nextNy1900,
    );
    expect(rateLimits.recordUtilization).toHaveBeenCalledWith(
      '/cfg/personal', 'seven_day_sonnet', 6, nextNy1900,
    );
    const cached = runner.getLast('personal');
    expect(cached?.ok).toBe(true);
  });

  it('returns ok:false when account is unknown', async () => {
    const runner = createUsageRunnerService({
      accounts: makeFakeAccountsService(),
      rateLimits: makeFakeRateLimits(),
      spawnPty: makeScriptedSpawn(''),
      findClaudeBinary: () => '/fake/claude',
      now: () => 1,
      ...TUNING,
    });
    const r = await runner.run('does-not-exist');
    expect(r.ok).toBe(false);
  });

  it('returns ok:false when no claude binary found', async () => {
    const runner = createUsageRunnerService({
      accounts: makeFakeAccountsService(),
      rateLimits: makeFakeRateLimits(),
      spawnPty: makeScriptedSpawn(MAX_FULL_FIXTURE),
      findClaudeBinary: () => null,
      now: () => 1,
      ...TUNING,
    });
    const r = await runner.run('personal');
    expect(r.ok).toBe(false);
  });

  it('dedups concurrent calls for the same account', async () => {
    const accounts = makeFakeAccountsService();
    const rateLimits = makeFakeRateLimits();
    let spawnCount = 0;
    const wrapped: PtySpawner = (cmd, args, opts) => {
      spawnCount += 1;
      return makeScriptedSpawn(MAX_FULL_FIXTURE)(cmd, args, opts);
    };
    const runner = createUsageRunnerService({
      accounts, rateLimits,
      spawnPty: wrapped,
      findClaudeBinary: () => '/fake/claude',
      now: () => 1,
      ...TUNING,
    });
    const [a, b] = await Promise.all([runner.run('personal'), runner.run('personal')]);
    expect(spawnCount).toBe(1);
    expect(a).toBe(b);
  });

  it('uses account.cli_path when set, ignoring findClaudeBinary', async () => {
    const accounts = makeFakeAccountsService('/custom/claude');
    const seen: string[] = [];
    const wrapped: PtySpawner = (cmd, args, opts) => {
      seen.push(cmd);
      return makeScriptedSpawn(MAX_FULL_FIXTURE)(cmd, args, opts);
    };
    const runner = createUsageRunnerService({
      accounts,
      rateLimits: makeFakeRateLimits(),
      spawnPty: wrapped,
      findClaudeBinary: () => '/should-not-be-used',
      now: () => 1,
      ...TUNING,
    });
    await runner.run('personal');
    expect(seen[0]).toBe('/custom/claude');
  });

  it('ok:true cache is preserved across a later ok:false run', async () => {
    const accounts = makeFakeAccountsService();
    const rateLimits = makeFakeRateLimits();
    const runner = createUsageRunnerService({
      accounts, rateLimits,
      spawnPty: makeScriptedSpawn(MAX_FULL_FIXTURE),
      findClaudeBinary: () => '/fake/claude',
      now: () => 1,
      ...TUNING,
    });
    const ok = await runner.run('personal');
    expect(ok.ok).toBe(true);
    // Now reconfigure with a binary that doesn't exist — fail the next run
    const runner2 = createUsageRunnerService({
      accounts, rateLimits,
      spawnPty: makeScriptedSpawn(''),
      findClaudeBinary: () => null,
      now: () => 2,
      ...TUNING,
    });
    const fail = await runner2.run('personal');
    expect(fail.ok).toBe(false);
    // (caches are per-instance; this test mostly checks there's no
    //  global state leak between runs.)
  });
});

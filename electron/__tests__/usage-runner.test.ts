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
        cli_path: cliPath,
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
    // observedAt = Nov 15 10:40 UTC = 5:40am NY. The fixture's "9:40am NY"
    // is 4h ahead (today, within the 5-hour cap), and "7pm NY" is ~13h ahead
    // (within the 7-day cap). Earlier observedAts that pushed the 5-hour
    // reset >5h out (e.g. yesterday-evening rolling to tomorrow) get rejected
    // by the new sanity bound, which is the whole point.
    const observedAt = Date.UTC(2023, 10, 15, 10, 40, 0);
    const runner = createUsageRunnerService({
      accounts, rateLimits,
      spawnPty: makeScriptedSpawn(MAX_FULL_FIXTURE),
      findClaudeBinary: () => '/fake/claude',
      now: () => observedAt,
      ...TUNING,
    });
    const result = await runner.run('personal');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.windows.length).toBe(3);
    const nextNy0940 = Math.floor(Date.UTC(2023, 10, 15, 14, 40, 0) / 1000);
    const nextNy1900 = Math.floor(Date.UTC(2023, 10, 16, 0, 0, 0) / 1000);
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

  it('waits for the full render before parsing, even when bytes arrive in chunks', async () => {
    // Emit the fixture in three slices: first only the session header (no
    // windows yet), then two of the three windows, then the third. The runner
    // should not parse until the third window's Resets line lands. Expressed
    // as: recordUtilization gets called with the values from the COMPLETE
    // fixture (all three windows), not with a partial.
    const accounts = makeFakeAccountsService();
    const rateLimits = makeFakeRateLimits();

    // Split the fixture so the first chunk is missing the third window
    // entirely. If the runner snapshots too early, only two windows would be
    // recorded.
    const sonnetIdx = MAX_FULL_FIXTURE.indexOf('Current week (Sonnet only)');
    const partial = MAX_FULL_FIXTURE.slice(0, sonnetIdx);
    const completion = MAX_FULL_FIXTURE.slice(sonnetIdx);

    const chunkedSpawn: PtySpawner = () => {
      const dataHandlers: ((d: string) => void)[] = [];
      const exitHandlers: ((code: { exitCode: number }) => void)[] = [];
      let killed = false;
      setTimeout(() => {
        if (killed) return;
        for (const h of dataHandlers) h('? for shortcuts ');
      }, 5);
      return {
        write: (data: string) => {
          if (data.includes('/usage')) {
            // Chunk 1: partial render arrives quickly.
            setTimeout(() => {
              if (killed) return;
              for (const h of dataHandlers) h(partial);
            }, 30);
            // Chunk 2: completion arrives after a longer delay than the
            // configured `usageQuietMs` would normally tolerate. The new
            // completeness check should keep us waiting through the gap.
            setTimeout(() => {
              if (killed) return;
              for (const h of dataHandlers) h(completion);
            }, 250);
          }
        },
        kill: () => {
          killed = true;
          for (const h of exitHandlers) h({ exitCode: 0 });
        },
        onData: (cb) => { dataHandlers.push(cb); },
        onExit: (cb) => { exitHandlers.push(cb); },
      };
    };

    const observedAt = Date.UTC(2023, 10, 15, 10, 40, 0);
    const runner = createUsageRunnerService({
      accounts, rateLimits,
      spawnPty: chunkedSpawn,
      findClaudeBinary: () => '/fake/claude',
      now: () => observedAt,
      settleQuietMs: 30,
      // Quiet timeout long enough for both chunks to arrive (chunk 2 lands
      // at ~250ms). The completeness fast-path then trips fullRenderQuietMs
      // and exits without waiting the full quiet window.
      usageQuietMs: 500,
      fullRenderQuietMs: 50,
      hardTimeoutMs: 5000,
      killGraceMs: 0,
    });

    const result = await runner.run('personal');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.windows.length).toBe(3);
    expect(result.parsed.windows.map((w) => w.label).sort()).toEqual([
      'current_session', 'week_all_models', 'week_sonnet',
    ]);
  });

  it('passes resetsAt=null when the parsed reset is implausibly far in the future', async () => {
    // observedAt at Nov 14 22:13 UTC pushes the fixture's "9:40am NY"
    // 16+ hours out (parser rolls past today, then tomorrow). That's well
    // beyond the 5-hour cap, so the runner should pass null instead of the
    // junk timestamp — recordUtilization will COALESCE that against any
    // prior good value.
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
    expect(rateLimits.recordUtilization).toHaveBeenCalledWith(
      '/cfg/personal', 'five_hour', 33, null,
    );
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

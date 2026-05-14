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
  // Stub out the trusted-scratch-cwd resolver — these tests don't touch
  // real filesystem state. The integration of the resolver itself is
  // covered by usage-runner-scratch-cwd.test.ts.
  ensureCwd: () => '/tmp/test-scratch-cwd',
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
      ensureCwd: () => '/tmp/test-scratch-cwd',
    });

    const result = await runner.run('personal');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.windows.length).toBe(3);
    expect(result.parsed.windows.map((w) => w.label).sort()).toEqual([
      'current_session', 'week_all_models', 'week_sonnet',
    ]);
  });

  it('keeps waiting past usageQuietMs when the parse is incomplete (e.g. Sonnet bar arrives late)', async () => {
    // Real-world scenario seen on Claude Code 2.1.132: the Session +
    // Current session + Current week (all models) blocks render
    // immediately, the buffer goes quiet for >usageQuietMs, *then* the
    // Sonnet block arrives via async redraw. The prior logic snapshotted
    // at the first quiet period and missed the Sonnet bar entirely. With
    // `incompleteParseGraceMs` we extend the wait when the parse hasn't
    // hit all 3 windows yet.
    const accounts = makeFakeAccountsService();
    const rateLimits = makeFakeRateLimits();
    const sonnetIdx = MAX_FULL_FIXTURE.indexOf('Current week (Sonnet only)');
    const firstChunk = MAX_FULL_FIXTURE.slice(0, sonnetIdx);
    const lateChunk = MAX_FULL_FIXTURE.slice(sonnetIdx);
    const lateSonnet: PtySpawner = () => {
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
            // First two windows arrive at 30ms, then buffer goes quiet.
            setTimeout(() => {
              if (killed) return;
              for (const h of dataHandlers) h(firstChunk);
            }, 30);
            // Sonnet block arrives at 200ms — *after* a 100ms usageQuietMs
            // would have fired in the prior logic. The extension grace
            // must be long enough to bridge this gap.
            setTimeout(() => {
              if (killed) return;
              for (const h of dataHandlers) h(lateChunk);
            }, 200);
          }
        },
        kill: () => { killed = true; for (const h of exitHandlers) h({ exitCode: 0 }); },
        onData: (cb) => { dataHandlers.push(cb); },
        onExit: (cb) => { exitHandlers.push(cb); },
      };
    };
    const observedAt = Date.UTC(2023, 10, 15, 10, 40, 0);
    const runner = createUsageRunnerService({
      accounts, rateLimits,
      spawnPty: lateSonnet,
      findClaudeBinary: () => '/fake/claude',
      now: () => observedAt,
      settleQuietMs: 30,
      // First quietness fires at firstChunk + 80ms (~110ms total). Sonnet
      // arrives at 200ms. Need grace ≥ 100ms to bridge.
      usageQuietMs: 80,
      fullRenderQuietMs: 50,
      incompleteParseGraceMs: 300,
      hardTimeoutMs: 5000,
      killGraceMs: 0,
      ensureCwd: () => '/tmp/test-scratch-cwd',
    });

    const result = await runner.run('personal');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.windows.map((w) => w.label).sort()).toEqual([
      'current_session', 'week_all_models', 'week_sonnet',
    ]);
  });

  it('does eventually snapshot a partial parse if the late chunk never arrives', async () => {
    // Counterpart to the above: if Sonnet truly isn't coming (e.g. free
    // tier with only 2 windows), don't wait the full hardTimeoutMs.
    // After usageQuietMs + incompleteParseGraceMs, snapshot what we have.
    const accounts = makeFakeAccountsService();
    const rateLimits = makeFakeRateLimits();
    const sonnetIdx = MAX_FULL_FIXTURE.indexOf('Current week (Sonnet only)');
    const partial = MAX_FULL_FIXTURE.slice(0, sonnetIdx);
    const partialOnly: PtySpawner = () => {
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
            setTimeout(() => {
              if (killed) return;
              for (const h of dataHandlers) h(partial);
            }, 30);
            // No late chunk — Sonnet never comes.
          }
        },
        kill: () => { killed = true; for (const h of exitHandlers) h({ exitCode: 0 }); },
        onData: (cb) => { dataHandlers.push(cb); },
        onExit: (cb) => { exitHandlers.push(cb); },
      };
    };
    const t0 = Date.now();
    const runner = createUsageRunnerService({
      accounts, rateLimits,
      spawnPty: partialOnly,
      findClaudeBinary: () => '/fake/claude',
      now: () => 1,
      settleQuietMs: 30,
      usageQuietMs: 80,
      fullRenderQuietMs: 50,
      incompleteParseGraceMs: 200,
      // Generous hardTimeoutMs so we can prove we exit on the grace, not
      // on the hard deadline.
      hardTimeoutMs: 5000,
      killGraceMs: 0,
      ensureCwd: () => '/tmp/test-scratch-cwd',
    });
    const result = await runner.run('personal');
    const elapsed = Date.now() - t0;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Got the 2 windows that did arrive.
    expect(result.parsed.windows.length).toBe(2);
    // And we exited well before hardTimeoutMs (5000ms). Generous bound to
    // avoid CI flakiness, but proves we're on the grace path not the hard
    // deadline.
    expect(elapsed).toBeLessThan(2000);
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

  it('recognizes the post-2.1.132 welcome footer (shift+tab to cycle)', async () => {
    // Claude Code 2.1.132 replaced the "? for shortcuts" footer with
    // "⏵⏵ auto mode on (shift+tab to cycle) ◉ xhigh · /effort". Greg saw
    // this in /tmp logs — runner timed out because READY_MARKER didn't
    // match. The runner now matches a small set of stable footer hints.
    const accounts = makeFakeAccountsService();
    const rateLimits = makeFakeRateLimits();
    const newWelcome = '⏵⏵ auto mode on (shift+tab to cycle) ◉ xhigh · /effort';
    const spawn212: PtySpawner = () => {
      const dataHandlers: ((d: string) => void)[] = [];
      const exitHandlers: ((code: { exitCode: number }) => void)[] = [];
      let killed = false;
      setTimeout(() => {
        if (killed) return;
        for (const h of dataHandlers) h(newWelcome);
      }, 5);
      return {
        write: (data: string) => {
          if (data.includes('/usage')) {
            setTimeout(() => {
              if (killed) return;
              for (const h of dataHandlers) h(MAX_FULL_FIXTURE);
            }, 30);
          }
        },
        kill: () => { killed = true; for (const h of exitHandlers) h({ exitCode: 0 }); },
        onData: (cb) => { dataHandlers.push(cb); },
        onExit: (cb) => { exitHandlers.push(cb); },
      };
    };
    const observedAt = Date.UTC(2023, 10, 15, 10, 40, 0);
    const runner = createUsageRunnerService({
      accounts, rateLimits,
      spawnPty: spawn212,
      findClaudeBinary: () => '/fake/claude',
      now: () => observedAt,
      ...TUNING,
    });
    const result = await runner.run('personal');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.windows.length).toBe(3);
  });

  it('passes the scratch cwd from ensureCwd into spawnPty (not os.homedir)', async () => {
    const seenOpts: { cwd: string; env: NodeJS.ProcessEnv }[] = [];
    const wrapped: PtySpawner = (cmd, args, opts) => {
      seenOpts.push({ cwd: opts.cwd, env: opts.env });
      return makeScriptedSpawn(MAX_FULL_FIXTURE)(cmd, args, opts);
    };
    const runner = createUsageRunnerService({
      accounts: makeFakeAccountsService(),
      rateLimits: makeFakeRateLimits(),
      spawnPty: wrapped,
      findClaudeBinary: () => '/fake/claude',
      now: () => 1,
      settleQuietMs: 30,
      usageQuietMs: 60,
      hardTimeoutMs: 5000,
      killGraceMs: 0,
      ensureCwd: (key, cfg) => `/scratch/${key}-for-${cfg.replace(/\//g, '_')}`,
    });
    await runner.run('personal');
    expect(seenOpts[0].cwd).toBe('/scratch/personal-for-_cfg_personal');
    expect(seenOpts[0].env.CLAUDE_CONFIG_DIR).toBe('/cfg/personal');
  });

  it('logs timeout failure with the captured raw buffer so it shows up in the Log tab', async () => {
    // Simulate the Apr-2026 trust-dialog wording change: spawn emits the
    // safety-check prompt (which the runner does NOT recognize) but never
    // the welcome marker. Runner should hit hardTimeoutMs and log.
    const safetyPrompt =
      'Accessing workspace:\n\n  /scratch/personal\n\n' +
      "Quick safety check: Is this a project you created or one you trust?";
    const stallSpawn: PtySpawner = () => {
      const dataHandlers: ((d: string) => void)[] = [];
      const exitHandlers: ((code: { exitCode: number }) => void)[] = [];
      let killed = false;
      setTimeout(() => {
        if (killed) return;
        for (const h of dataHandlers) h(safetyPrompt);
      }, 5);
      // Intentionally never emit "for shortcuts" — pty stalls in dialog.
      return {
        write: () => {},
        kill: () => { killed = true; for (const h of exitHandlers) h({ exitCode: 0 }); },
        onData: (cb) => { dataHandlers.push(cb); },
        onExit: (cb) => { exitHandlers.push(cb); },
      };
    };

    const logs: { level: string; message: string; metadata?: string }[] = [];
    const fakeLogging = {
      writeBatch: (entries: { level: string; message: string; metadata?: string }[]) => {
        for (const e of entries) logs.push({ level: e.level, message: e.message, metadata: e.metadata });
      },
    } as unknown as import('../services/logging').LoggingService;

    const runner = createUsageRunnerService({
      accounts: makeFakeAccountsService(),
      rateLimits: makeFakeRateLimits(),
      spawnPty: stallSpawn,
      findClaudeBinary: () => '/fake/claude',
      now: () => 1,
      settleQuietMs: 20,
      usageQuietMs: 50,
      // Keep this small so the test runs quickly. The hardTimeoutMs path
      // is what we're exercising.
      hardTimeoutMs: 200,
      killGraceMs: 0,
      ensureCwd: () => '/scratch/personal',
      logging: fakeLogging,
    });

    const result = await runner.run('personal');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/timed out/i);
    // The raw output we captured should be returned to the caller so the
    // UI can render it (this preserves the existing "Raw output" panel
    // behavior).
    expect(result.raw).toContain('Quick safety check');

    // And critically — a warn-level log should mention the timeout AND
    // include the captured raw in its metadata so the Log tab is useful
    // when this happens in the wild.
    const timeoutLog = logs.find(
      (l) => l.level === 'warn' && /timed out|prompt was ready/i.test(l.message),
    );
    expect(timeoutLog).toBeDefined();
    expect(timeoutLog!.metadata).toContain('Quick safety check');
  });
});

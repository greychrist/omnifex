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

What's contributing to your limits usage?
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
  ensureCwd: () => '/tmp/test-scratch-cwd',
};

describe('usage-runner', () => {
  it('happy path: parses, dual-writes recordUtilization, caches result', async () => {
    const accounts = makeFakeAccountsService();
    const rateLimits = makeFakeRateLimits();
    // observedAt = Nov 15 10:40 UTC = 5:40am NY: "9:40am NY" is 4h ahead (inside
    // the 5-hour cap) and "7pm NY" ~13h (inside the 7-day cap).
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

  it('launches the TUI with no MCP servers — /usage reads local history, and starting them cost ~84 spawns a scrape', async () => {
    // The /usage tables are "based on local sessions", so MCP servers change
    // nothing.
    const calls: { command: string; args: string[] }[] = [];
    const scripted = makeScriptedSpawn(MAX_FULL_FIXTURE);
    const runner = createUsageRunnerService({
      accounts: makeFakeAccountsService(),
      rateLimits: makeFakeRateLimits(),
      spawnPty: (command, args, opts) => { calls.push({ command, args }); return scripted(command, args, opts); },
      findClaudeBinary: () => '/fake/claude',
      now: () => Date.UTC(2023, 10, 15, 10, 40, 0),
      ...TUNING,
    });
    await runner.run('personal');
    expect(calls).toEqual([{ command: '/fake/claude', args: ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'] }]);
  });

  it('stale (last-known) render: returns parsed data flagged stale, never records utilization', async () => {
    const STALE_FIXTURE = MAX_FULL_FIXTURE.replace(
      '\nCurrent session',
      '\nShowing last-known usage as of 5:43pm (rate limited — try again in a moment)\n\nCurrent session',
    );
    const accounts = makeFakeAccountsService();
    const rateLimits = makeFakeRateLimits();
    const runner = createUsageRunnerService({
      accounts, rateLimits,
      spawnPty: makeScriptedSpawn(STALE_FIXTURE),
      findClaudeBinary: () => '/fake/claude',
      now: () => Date.UTC(2023, 10, 15, 10, 40, 0),
      ...TUNING,
    });
    const result = await runner.run('personal');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.stale).toBe(true);
    expect(result.parsed.windows.length).toBe(3);
    expect(rateLimits.recordUtilization).not.toHaveBeenCalled();
  });

  it('waits for the full render before parsing, even when bytes arrive in chunks', async () => {
    const accounts = makeFakeAccountsService();
    const rateLimits = makeFakeRateLimits();

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
            setTimeout(() => {
              if (killed) return;
              for (const h of dataHandlers) h(partial);
            }, 30);
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
    // The Sonnet block can arrive by async redraw after the buffer goes quiet
    // (2.1.132).
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
            setTimeout(() => {
              if (killed) return;
              for (const h of dataHandlers) h(firstChunk);
            }, 30);
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

  it('keeps waiting while "Loading usage data…" placeholder is visible (Claude Code 2.1.146+ async load)', async () => {
    // Since 2.1.146 /usage async-loads the rate-limit blocks behind a "Loading
    // usage data…" placeholder.
    const accounts = makeFakeAccountsService();
    const rateLimits = makeFakeRateLimits();
    const sessionBlock = MAX_FULL_FIXTURE.slice(
      0,
      MAX_FULL_FIXTURE.indexOf('Current session'),
    );
    const placeholder = '\nLoading usage data…\n';
    const rateLimitBlocks = MAX_FULL_FIXTURE.slice(
      MAX_FULL_FIXTURE.indexOf('Current session'),
    );
    const lateData: PtySpawner = () => {
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
              for (const h of dataHandlers) h(sessionBlock + placeholder);
            }, 30);
            // 500ms quiet: past usageQuietMs (80) + incompleteParseGraceMs (100).
            setTimeout(() => {
              if (killed) return;
              for (const h of dataHandlers) h(rateLimitBlocks);
            }, 600);
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
      spawnPty: lateData,
      findClaudeBinary: () => '/fake/claude',
      now: () => observedAt,
      settleQuietMs: 30,
      usageQuietMs: 80,
      fullRenderQuietMs: 50,
      incompleteParseGraceMs: 100,
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
    expect(result.parsed.windows.length).toBe(2);
    // A generous bound against suite load that still proves the grace path.
    expect(elapsed).toBeLessThan(2000);
  });

  it('passes resetsAt=null when the parsed reset is implausibly far in the future', async () => {
    // observedAt Nov 14 22:13 UTC pushes "9:40am NY" 16+ hours out, past the
    // 5-hour cap.
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
    const runner2 = createUsageRunnerService({
      accounts, rateLimits,
      spawnPty: makeScriptedSpawn(''),
      findClaudeBinary: () => null,
      now: () => 2,
      ...TUNING,
    });
    const fail = await runner2.run('personal');
    expect(fail.ok).toBe(false);
  });

  it('recognizes the post-2.1.132 welcome footer (shift+tab to cycle)', async () => {
    // 2.1.132 replaced the "? for shortcuts" footer with "⏵⏵ auto mode on
    // (shift+tab to cycle) ◉ xhigh · /effort".
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

  it('recognizes the 2.1.146 welcome footer even when ANSI stripping collapses inter-word spaces', async () => {
    // 2.1.146 spaces the banner with cursor moves, so stripAnsi() output loses the
    // spaces; the matcher normalizes whitespace on both sides.
    const accounts = makeFakeAccountsService();
    const rateLimits = makeFakeRateLimits();
    const stripped146 = '⏵⏵automodeon (shift+tabtocycle)·←foragents◉xhigh·/effort';
    const spawn146: PtySpawner = () => {
      const dataHandlers: ((d: string) => void)[] = [];
      const exitHandlers: ((code: { exitCode: number }) => void)[] = [];
      let killed = false;
      setTimeout(() => {
        if (killed) return;
        for (const h of dataHandlers) h(stripped146);
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
      spawnPty: spawn146,
      findClaudeBinary: () => '/fake/claude',
      now: () => observedAt,
      ...TUNING,
    });
    const result = await runner.run('personal');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.windows.length).toBe(3);
  });

  describe('reset-epoch acceptance', () => {
    function makeLoggingSpy() {
      const rows: { level: string; message: string; metadata?: string }[] = [];
      return {
        rows,
        logging: {
          writeBatch: (batch: typeof rows) => { rows.push(...batch); },
        } as unknown as import('../services/logging').LoggingService,
      };
    }

    it('accepts a reset time that has only just passed instead of rejecting it', async () => {
      // The window can roll over mid-capture: "5:19pm" read at 17:19:16.
      const observedAt = Date.UTC(2026, 7, 22, 21, 19, 16);
      const fixture = MAX_FULL_FIXTURE.replace(
        'Resets 9:40am (America/New_York)',
        'Resets 5:19pm (America/New_York)',
      );
      const { rows, logging } = makeLoggingSpy();
      const recordUtilization = vi.fn();
      const runner = createUsageRunnerService({
        accounts: makeFakeAccountsService(),
        rateLimits: { recordUtilization } as unknown as import('../services/rate-limits').RateLimitsService,
        spawnPty: makeScriptedSpawn(fixture),
        findClaudeBinary: () => '/fake/claude',
        now: () => observedAt,
        logging,
        ...TUNING,
      });
      const result = await runner.run('personal');
      expect(result.ok).toBe(true);

      const fiveHour = recordUtilization.mock.calls.find((c) => c[1] === 'five_hour');
      expect(fiveHour).toBeDefined();
      expect(fiveHour?.[3]).toBe(Math.floor(observedAt / 1000));
      expect(rows.some((r) => r.message.startsWith('rejected reset epoch'))).toBe(false);
    });

    it('treats an absent Resets line as absent, not as a parse failure', async () => {
      // The CLI sometimes renders the current-session window with no Resets line.
      const observedAt = Date.UTC(2023, 10, 15, 10, 40, 0);
      const fixture = MAX_FULL_FIXTURE.replace('Resets 9:40am (America/New_York)\n', '');
      const { rows, logging } = makeLoggingSpy();
      const recordUtilization = vi.fn();
      const runner = createUsageRunnerService({
        accounts: makeFakeAccountsService(),
        rateLimits: { recordUtilization } as unknown as import('../services/rate-limits').RateLimitsService,
        spawnPty: makeScriptedSpawn(fixture),
        findClaudeBinary: () => '/fake/claude',
        now: () => observedAt,
        logging,
        ...TUNING,
      });
      const result = await runner.run('personal');
      expect(result.ok).toBe(true);

      // recordUtilization COALESCEs a null reset against the last known-good value.
      const fiveHour = recordUtilization.mock.calls.find((c) => c[1] === 'five_hour');
      expect(fiveHour?.[3]).toBeNull();
      expect(rows.some((r) => r.message.startsWith('rejected reset epoch'))).toBe(false);
      const absent = rows.find((r) => r.metadata?.includes('"reason":"absent"'));
      expect(absent).toBeDefined();
      expect(absent?.level).not.toBe('warn');
    });

    it('still warns when a Resets label is present but unrecognized', async () => {
      const observedAt = Date.UTC(2023, 10, 15, 10, 40, 0);
      const fixture = MAX_FULL_FIXTURE.replace(
        'Resets 9:40am (America/New_York)',
        'Resets sometime on Thursday',
      );
      const { rows, logging } = makeLoggingSpy();
      const runner = createUsageRunnerService({
        accounts: makeFakeAccountsService(),
        rateLimits: makeFakeRateLimits(),
        spawnPty: makeScriptedSpawn(fixture),
        findClaudeBinary: () => '/fake/claude',
        now: () => observedAt,
        logging,
        ...TUNING,
      });
      await runner.run('personal');
      const warn = rows.find((r) => r.message.startsWith('rejected reset epoch'));
      expect(warn?.level).toBe('warn');
      expect(warn?.metadata).toContain('"reason":"unparseable"');
    });
  });

  it('dismisses the Chrome-extension interstitial (Esc) and still reaches /usage', async () => {
    // The Chrome-extension prompt's default choice opts into browser tools, so Esc,
    // never Enter.
    const chromePrompt = [
      ' Claude in Chrome extension detected',
      '',
      ' Claude will use your Chrome browser by default.',
      '',
      ' ❯ 1. Yes, use my browser',
      ' 2. No, keep browser tools off',
      '',
      ' Enter to confirm · Esc to keep browser tools off',
    ].join('\n');

    const writes: string[] = [];
    const chromeSpawn: PtySpawner = () => {
      const dataHandlers: ((d: string) => void)[] = [];
      const exitHandlers: ((code: { exitCode: number }) => void)[] = [];
      let killed = false;
      setTimeout(() => {
        if (killed) return;
        for (const h of dataHandlers) h(chromePrompt);
      }, 5);
      return {
        write: (data: string) => {
          writes.push(data);
          if (data.includes('\x1b')) {
            setTimeout(() => {
              if (killed) return;
              for (const h of dataHandlers) h('\n? for shortcuts ');
            }, 5);
          }
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
      accounts: makeFakeAccountsService(),
      rateLimits: makeFakeRateLimits(),
      spawnPty: chromeSpawn,
      findClaudeBinary: () => '/fake/claude',
      now: () => observedAt,
      ...TUNING,
    });
    const result = await runner.run('personal');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.windows.length).toBe(3);
    const escIdx = writes.findIndex((w) => w.includes('\x1b'));
    const usageIdx = writes.findIndex((w) => w.includes('/usage'));
    expect(escIdx).toBeGreaterThanOrEqual(0);
    expect(escIdx).toBeLessThan(usageIdx);
  });

  it('dismisses the fullscreen-renderer offer (Esc) and still reaches /usage', async () => {
    // CLI 2.1.239+ shows the fullscreen offer INSTEAD of the welcome screen for up
    // to three impressions.
    const upsellPrompt = [
      ' Try the new fullscreen renderer?',
      '',
      ' · Flicker-free output — fixes the flashing you see during long responses',
      ' · Mouse support — click to move your cursor or expand results',
      ' · Selected text auto-copies to your clipboard',
      '',
      ' ❯ 1. Yes, try it',
      ' 2. Not now',
      '',
      ' Enter to confirm · Esc to cancel',
    ].join('\n');

    const writes: string[] = [];
    const upsellSpawn: PtySpawner = () => {
      const dataHandlers: ((d: string) => void)[] = [];
      const exitHandlers: ((code: { exitCode: number }) => void)[] = [];
      let killed = false;
      setTimeout(() => {
        if (killed) return;
        for (const h of dataHandlers) h(upsellPrompt);
      }, 5);
      return {
        write: (data: string) => {
          writes.push(data);
          if (data.includes('\x1b')) {
            setTimeout(() => {
              if (killed) return;
              for (const h of dataHandlers) h('\n? for shortcuts ');
            }, 5);
          }
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
      accounts: makeFakeAccountsService(),
      rateLimits: makeFakeRateLimits(),
      spawnPty: upsellSpawn,
      findClaudeBinary: () => '/fake/claude',
      now: () => observedAt,
      ...TUNING,
    });
    const result = await runner.run('personal');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.windows.length).toBe(3);
    const escIdx = writes.findIndex((w) => w.includes('\x1b'));
    const usageIdx = writes.findIndex((w) => w.includes('/usage'));
    expect(escIdx).toBeGreaterThanOrEqual(0);
    expect(escIdx).toBeLessThan(usageIdx);
    // Enter would accept the trial.
    expect(writes.slice(0, escIdx).some((w) => w.includes('\r'))).toBe(false);
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
      hardTimeoutMs: 200,
      killGraceMs: 0,
      ensureCwd: () => '/scratch/personal',
      logging: fakeLogging,
    });

    const result = await runner.run('personal');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/timed out/i);
    expect(result.raw).toContain('Quick safety check');

    const timeoutLog = logs.find(
      (l) => l.level === 'warn' && /timed out|prompt was ready/i.test(l.message),
    );
    expect(timeoutLog).toBeDefined();
    expect(timeoutLog!.metadata).toContain('Quick safety check');
  });

  it('warns in the Log tab when a parse succeeds but a CLI label has drifted (silent zero)', async () => {
    const drifted = MAX_FULL_FIXTURE.replace('Total cost:             $0.0000', 'Total spend:            $4.2000');

    const logs: { level: string; message: string; metadata?: string }[] = [];
    const fakeLogging = {
      writeBatch: (entries: { level: string; message: string; metadata?: string }[]) => {
        for (const e of entries) logs.push({ level: e.level, message: e.message, metadata: e.metadata });
      },
    } as unknown as import('../services/logging').LoggingService;

    const runner = createUsageRunnerService({
      accounts: makeFakeAccountsService(),
      rateLimits: makeFakeRateLimits(),
      spawnPty: makeScriptedSpawn(drifted),
      findClaudeBinary: () => '/fake/claude',
      now: () => Date.UTC(2023, 10, 15, 10, 40, 0),
      ...TUNING,
      logging: fakeLogging,
    });

    const result = await runner.run('personal');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.session.cost_usd).toBe(0);

    const driftLog = logs.find(
      (l) => l.level === 'warn' && /drift/i.test(l.message),
    );
    expect(driftLog).toBeDefined();
    expect(driftLog!.metadata).toContain('Total cost:');
  });

  it('does not emit a drift warning for a healthy render', async () => {
    const logs: { level: string; message: string; metadata?: string }[] = [];
    const fakeLogging = {
      writeBatch: (entries: { level: string; message: string; metadata?: string }[]) => {
        for (const e of entries) logs.push({ level: e.level, message: e.message, metadata: e.metadata });
      },
    } as unknown as import('../services/logging').LoggingService;

    const runner = createUsageRunnerService({
      accounts: makeFakeAccountsService(),
      rateLimits: makeFakeRateLimits(),
      spawnPty: makeScriptedSpawn(MAX_FULL_FIXTURE),
      findClaudeBinary: () => '/fake/claude',
      now: () => Date.UTC(2023, 10, 15, 10, 40, 0),
      ...TUNING,
      logging: fakeLogging,
    });

    const result = await runner.run('personal');
    expect(result.ok).toBe(true);
    expect(logs.some((l) => /drift/i.test(l.message))).toBe(false);
  });
});

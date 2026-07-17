import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createUsageService } from '../services/usage';
import type { AccountsService, Account } from '../services/accounts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
}

function writeJsonl(filePath: string, lines: object[]): void {
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

function assistantMessage(opts: {
  model?: string;
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
  timestamp?: string;
}): object {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      usage: {
        input_tokens: opts.input ?? 100,
        output_tokens: opts.output ?? 50,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
      },
      model: opts.model ?? 'claude-sonnet-4-5-20250514',
    },
    timestamp: opts.timestamp ?? '2026-04-09T12:00:00Z',
  };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 1,
    name: 'Test',
    config_dir: '',
    engine: 'claude',
    subscription_label: 'pro',
    has_cost: true,
    color: null,
    icon: null,
    cli_path: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeAccountsService(configDirs: string[]): AccountsService {
  const accounts = configDirs.map((dir, i) =>
    makeAccount({ id: i + 1, name: `Account ${i + 1}`, config_dir: dir }),
  );

  return {
    listAccounts: () => accounts,
    createAccount: () => accounts[0],
    updateAccount: () => {},
    updateSummarySettings: () => {},
    deleteAccount: () => {},
    listPathRules: () => [],
    addPathRule: () => ({ id: 1, account_id: 1, account_name: 'Test', account_engine: 'claude', path_prefix: '/', priority: 0 }),
    removePathRule: () => {},
    resolve: () => ({ claude: null, codex: null }),
    setProjectOverride: () => {},
    listProjectOverrides: () => [],
    explainResolution: () => null,
    discoverAccounts: async () => [],
    scanForNewAccounts: async () => [],
  };
}

// ---------------------------------------------------------------------------
// Fixtures: build a temp Claude config dir with JSONL session files
// ---------------------------------------------------------------------------

function buildConfigDir(configDir: string, projects: { name: string; sessions: object[][] }[]): void {
  const projectsDir = path.join(configDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  for (const project of projects) {
    const projectDir = path.join(projectsDir, project.name);
    fs.mkdirSync(projectDir, { recursive: true });

    project.sessions.forEach((lines, idx) => {
      const sessionFile = path.join(projectDir, `session-${idx}.jsonl`);
      writeJsonl(sessionFile, lines);
    });
  }
}

// ---------------------------------------------------------------------------
// Fake LoggingService — collects writeBatch calls for assertions
// ---------------------------------------------------------------------------

interface FakeLogger {
  writeBatch: (entries: unknown[]) => void;
  query: () => never;
  count: () => never;
  prune: () => never;
  /** Test-only: the entries the service under test passed to writeBatch. */
  getEntries: () => any[];
}

function makeFakeLogger(): FakeLogger {
  const collected: any[] = [];
  return {
    writeBatch: (entries: any[]) => collected.push(...entries),
    query: () => { throw new Error('not expected in test'); },
    count: () => { throw new Error('not expected in test'); },
    prune: () => { throw new Error('not expected in test'); },
    getEntries: () => collected,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usage service', () => {
  let tmpDirs: string[] = [];

  function makeTmp(): string {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tmpDirs = [];
  });

  // -------------------------------------------------------------------------
  // 0. Error logging — IO failures surface via LoggingService, not silently swallowed
  // -------------------------------------------------------------------------

  describe('IO error logging', () => {
    it('logs a warn entry when an account configDir is missing/unreadable', () => {
      // Point the account at a path that doesn't exist so the projects/ readdirSync throws.
      const accounts = makeAccountsService(['/this/path/definitely/does/not/exist']);
      const logger = makeFakeLogger();
      const service = createUsageService(accounts, logger);

      const stats = service.getUsageStats();

      // Still returns cleanly — missing configDir isn't a crashy error.
      expect(stats.total_sessions).toBe(0);

      // But the failure should have been logged.
      const entries = logger.getEntries();
      expect(entries.length).toBeGreaterThan(0);
      const match = entries.find((e) => String(e.source) === 'usage');
      expect(match).toBeDefined();
      expect(match.level).toBe('warn');
      expect(String(match.message)).toMatch(/projects|readdir|scan/i);
    });

    it('logs when a project session dir is unreadable', () => {
      const configDir = makeTmp();
      // Create projects/ with one entry that is a file, not a dir — the outer
      // readdir succeeds, but the inner iteration skips non-dir entries. That's
      // fine; to actually trigger the inner catch we create a dir then chmod 0
      // so readdirSync on it throws EACCES. Skip on non-POSIX (Windows CI).
      const projectsDir = path.join(configDir, 'projects');
      const lockedProject = path.join(projectsDir, '-Users-greg-locked');
      fs.mkdirSync(lockedProject, { recursive: true });
      if (process.platform === 'win32') {
        // chmod on Windows doesn't reliably revoke read — punt.
        return;
      }
      fs.chmodSync(lockedProject, 0o000);

      try {
        const accounts = makeAccountsService([configDir]);
        const logger = makeFakeLogger();
        const service = createUsageService(accounts, logger);

        service.getUsageStats();

        const entries = logger.getEntries();
        const match = entries.find(
          (e) =>
            String(e.source) === 'usage' &&
            /project session dir/i.test(String(e.message)),
        );
        expect(match).toBeDefined();
        expect(match.level).toBe('warn');
      } finally {
        // Restore perms so afterEach cleanup works.
        fs.chmodSync(lockedProject, 0o700);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 1. getUsageStats — correct totals from JSONL files
  // -------------------------------------------------------------------------

  describe('getUsageStats()', () => {
    it('caches parsed sessions by mtime — a second query does not re-read unchanged files', () => {
      const configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-myproject',
          sessions: [[assistantMessage({ input: 100, output: 50 })]],
        },
      ]);

      const service = createUsageService(makeAccountsService([configDir]));
      const spy = vi.spyOn(fs, 'readFileSync');

      const first = service.getUsageStats();
      const readsAfterFirst = spy.mock.calls.length;
      expect(readsAfterFirst).toBeGreaterThan(0);

      const second = service.getUsageStats();
      // No additional JSONL reads: the file's mtime is unchanged so the cache
      // serves the parsed rows.
      expect(spy.mock.calls.length).toBe(readsAfterFirst);
      expect(second.total_tokens).toBe(first.total_tokens);

      spy.mockRestore();
    });

    it('re-reads a session file after its mtime changes', () => {
      const configDir = makeTmp();
      const projectDir = path.join(configDir, 'projects', '-Users-greg-myproject');
      fs.mkdirSync(projectDir, { recursive: true });
      const sessionFile = path.join(projectDir, 's1.jsonl');
      writeJsonl(sessionFile, [assistantMessage({ input: 100, output: 50 })]);

      const service = createUsageService(makeAccountsService([configDir]));
      expect(service.getUsageStats().total_input_tokens).toBe(100);

      // Rewrite with new content and bump mtime into the future so the cache
      // (keyed on mtimeMs) invalidates deterministically.
      writeJsonl(sessionFile, [assistantMessage({ input: 999, output: 1 })]);
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(sessionFile, future, future);

      expect(service.getUsageStats().total_input_tokens).toBe(999);
    });

    it('returns correct totals from JSONL files', () => {
      const configDir = makeTmp();

      // Project dir name encoding: '-Users-greg-myproject' => '/Users/greg/myproject'
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-myproject',
          sessions: [
            [
              assistantMessage({ model: 'claude-sonnet-4-5-20250514', input: 100, output: 50, cacheCreation: 10, cacheRead: 5 }),
              assistantMessage({ model: 'claude-sonnet-4-5-20250514', input: 200, output: 80, cacheCreation: 0, cacheRead: 0 }),
            ],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      expect(stats.total_input_tokens).toBe(300);
      expect(stats.total_output_tokens).toBe(130);
      expect(stats.total_cache_creation_tokens).toBe(10);
      expect(stats.total_cache_read_tokens).toBe(5);
      expect(stats.total_tokens).toBe(430);
      expect(stats.total_sessions).toBe(1);
      // Cost: sonnet rate 3/15 per M; cache read 0.1x input, cache write(5m) 1.25x input.
      // msg1 (100/50, cacheRead 5, cacheCreation 10): 100*3 + 50*15 + 5*(3*0.1) + 10*(3*1.25) = 1089
      // msg2 (200/80, no cache): 200*3 + 80*15 = 1800
      const M = 1_000_000;
      const expectedCost =
        (100 * 3 + 50 * 15 + 5 * (3 * 0.1) + 10 * (3 * 1.25)) / M + (200 * 3 + 80 * 15) / M;
      expect(stats.total_cost).toBeCloseTo(expectedCost, 10);
    });

    it('aggregates across multiple projects and accounts', () => {
      const configDir1 = makeTmp();
      const configDir2 = makeTmp();

      buildConfigDir(configDir1, [
        {
          name: '-Users-greg-proj1',
          sessions: [
            [assistantMessage({ model: 'claude-haiku-3', input: 1000, output: 500 })],
          ],
        },
      ]);

      buildConfigDir(configDir2, [
        {
          name: '-Users-greg-proj2',
          sessions: [
            [assistantMessage({ model: 'claude-opus-4', input: 100, output: 20 })],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir1, configDir2]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      expect(stats.total_input_tokens).toBe(1100);
      expect(stats.total_output_tokens).toBe(520);
      expect(stats.total_sessions).toBe(2);
    });

    it('populates by_model breakdown', () => {
      const configDir = makeTmp();

      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj',
          sessions: [
            [
              assistantMessage({ model: 'claude-sonnet-4-5-20250514', input: 100, output: 50 }),
              assistantMessage({ model: 'claude-haiku-3-5-20250514', input: 200, output: 100 }),
            ],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      expect(stats.by_model.length).toBeGreaterThanOrEqual(2);
      const sonnet = stats.by_model.find((m) => m.model.includes('sonnet'));
      const haiku = stats.by_model.find((m) => m.model.includes('haiku'));
      expect(sonnet).toBeDefined();
      expect(haiku).toBeDefined();
      expect(sonnet!.input_tokens).toBe(100);
      expect(haiku!.input_tokens).toBe(200);
    });

    it('populates by_date breakdown', () => {
      const configDir = makeTmp();

      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj',
          sessions: [
            [
              assistantMessage({ timestamp: '2026-04-09T08:00:00Z', input: 100, output: 50 }),
              assistantMessage({ timestamp: '2026-04-10T08:00:00Z', input: 200, output: 80 }),
            ],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      expect(stats.by_date.length).toBe(2);
      const apr9 = stats.by_date.find((d) => d.date === '2026-04-09');
      const apr10 = stats.by_date.find((d) => d.date === '2026-04-10');
      expect(apr9).toBeDefined();
      expect(apr10).toBeDefined();
      expect(apr9!.input_tokens).toBe(100);
      expect(apr10!.input_tokens).toBe(200);
    });

    it('populates by_project breakdown', () => {
      const configDir = makeTmp();

      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj1',
          sessions: [
            [assistantMessage({ input: 100, output: 50 })],
          ],
        },
        {
          name: '-Users-greg-proj2',
          sessions: [
            [assistantMessage({ input: 300, output: 100 })],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      expect(stats.by_project.length).toBe(2);
      const proj1 = stats.by_project.find((p) => p.project_path === '/Users/greg/proj1');
      const proj2 = stats.by_project.find((p) => p.project_path === '/Users/greg/proj2');
      expect(proj1).toBeDefined();
      expect(proj2).toBeDefined();
      expect(proj1!.total_tokens).toBe(150);
      expect(proj2!.total_tokens).toBe(400);
    });

    // Regression for the dashed-project-name bug: the encoded dir
    // `-Users-greg-Repos-work-pi-tuitive-fe` naively decodes to
    // `/Users/greg/Repos/work/pi/tuitive/fe`, which is wrong. The real
    // cwd is recoverable from any JSONL entry's `cwd` field; usage
    // should use that for the breakdown's project_path.
    it('recovers a project_path with literal dashes from the JSONL cwd field', () => {
      const configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-Repos-work-pi-tuitive-fe',
          sessions: [
            [
              { ...assistantMessage({ input: 10, output: 5 }), cwd: '/Users/greg/Repos/work/pi-tuitive-fe' },
            ],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      expect(stats.by_project.length).toBe(1);
      expect(stats.by_project[0].project_path).toBe('/Users/greg/Repos/work/pi-tuitive-fe');
    });

    // Regression: when a project folder is renamed, older JSONLs in the same
    // encoded project-id dir still carry the pre-rename cwd. The recovered
    // path must reflect the CURRENT name — i.e. the newest JSONL's cwd wins,
    // not whichever file happens to sort first by name.
    it('prefers the newest JSONL cwd so a renamed project shows under its current path', () => {
      const configDir = makeTmp();
      const projectId = '-Users-greg-Repos-personal-omnifex';
      const oldPath = '/Users/greg/Repos/personal/greychrist';
      const newPath = '/Users/greg/Repos/personal/omnifex';

      const projectDir = path.join(configDir, 'projects', projectId);
      fs.mkdirSync(projectDir, { recursive: true });

      // Older session (alphabetically first) carries the stale pre-rename cwd.
      const olderFile = path.join(projectDir, '00000000-old.jsonl');
      writeJsonl(olderFile, [
        { ...assistantMessage({ input: 10, output: 5 }), cwd: oldPath },
      ]);
      const olderTime = new Date('2026-01-01T00:00:00Z');
      fs.utimesSync(olderFile, olderTime, olderTime);

      // Newer session (alphabetically last) carries the post-rename cwd.
      const newerFile = path.join(projectDir, 'ffffffff-new.jsonl');
      writeJsonl(newerFile, [
        { ...assistantMessage({ input: 20, output: 10 }), cwd: newPath },
      ]);
      const newerTime = new Date('2026-05-01T00:00:00Z');
      fs.utimesSync(newerFile, newerTime, newerTime);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      // All entries from this project (regardless of which JSONL they came from)
      // collapse to the current cwd. No leakage of the stale name.
      expect(stats.by_project.length).toBe(1);
      expect(stats.by_project[0].project_path).toBe(newPath);
    });
  });

  // -------------------------------------------------------------------------
  // 2. getUsageStats — returns zeros when no data
  // -------------------------------------------------------------------------

  describe('getUsageStats() with no data', () => {
    it('returns zeros when no accounts', () => {
      const accounts = makeAccountsService([]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      expect(stats.total_cost).toBe(0);
      expect(stats.total_tokens).toBe(0);
      expect(stats.total_input_tokens).toBe(0);
      expect(stats.total_output_tokens).toBe(0);
      expect(stats.total_cache_creation_tokens).toBe(0);
      expect(stats.total_cache_read_tokens).toBe(0);
      expect(stats.total_sessions).toBe(0);
      expect(stats.by_model).toEqual([]);
      expect(stats.by_date).toEqual([]);
      expect(stats.by_project).toEqual([]);
    });

    it('returns zeros when config dir has no projects dir', () => {
      const configDir = makeTmp();
      // intentionally don't create projects/ subdirectory

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      expect(stats.total_tokens).toBe(0);
      expect(stats.total_sessions).toBe(0);
    });

    it('returns zeros when projects dir is empty', () => {
      const configDir = makeTmp();
      fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      expect(stats.total_tokens).toBe(0);
      expect(stats.total_sessions).toBe(0);
    });

    it('returns zeros when JSONL files contain no assistant messages', () => {
      const configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj',
          sessions: [
            [
              { type: 'user', message: { role: 'user', content: 'hello' } },
              { type: 'system', content: 'init' },
            ],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      expect(stats.total_tokens).toBe(0);
    });

    it('skips malformed JSONL lines without throwing', () => {
      const configDir = makeTmp();
      const projectDir = path.join(configDir, 'projects', '-Users-greg-proj');
      fs.mkdirSync(projectDir, { recursive: true });

      // Mix of valid and invalid lines
      fs.writeFileSync(
        path.join(projectDir, 'session.jsonl'),
        [
          'not json at all',
          JSON.stringify(assistantMessage({ input: 100, output: 50 })),
          '{broken json',
          JSON.stringify({ type: 'user', message: { role: 'user' } }),
        ].join('\n') + '\n',
        'utf8',
      );

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      // Only the valid assistant message should count
      expect(stats.total_input_tokens).toBe(100);
      expect(stats.total_output_tokens).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // 3. getUsageByDateRange — filters by date
  // -------------------------------------------------------------------------

  describe('getUsageByDateRange()', () => {
    let configDir: string;

    beforeEach(() => {
      configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj',
          sessions: [
            [
              assistantMessage({ timestamp: '2026-04-01T10:00:00Z', input: 100, output: 50 }),
              assistantMessage({ timestamp: '2026-04-05T10:00:00Z', input: 200, output: 80 }),
              assistantMessage({ timestamp: '2026-04-10T10:00:00Z', input: 300, output: 100 }),
              assistantMessage({ timestamp: '2026-04-15T10:00:00Z', input: 400, output: 120 }),
            ],
          ],
        },
      ]);
    });

    it('filters messages within inclusive date range', () => {
      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageByDateRange('2026-04-05', '2026-04-10');

      // Should include Apr 5 and Apr 10, exclude Apr 1 and Apr 15
      expect(stats.total_input_tokens).toBe(500); // 200 + 300
      expect(stats.total_output_tokens).toBe(180); // 80 + 100
    });

    it('returns zeros when range has no matching messages', () => {
      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageByDateRange('2026-03-01', '2026-03-31');

      expect(stats.total_tokens).toBe(0);
      expect(stats.total_sessions).toBe(0);
    });

    it('returns all messages when range covers everything', () => {
      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageByDateRange('2026-01-01', '2026-12-31');

      expect(stats.total_input_tokens).toBe(1000); // 100 + 200 + 300 + 400
      expect(stats.total_output_tokens).toBe(350); // 50 + 80 + 100 + 120
    });
  });

  // -------------------------------------------------------------------------
  // 4. getSessionStats — per-project breakdown
  // -------------------------------------------------------------------------

  describe('getSessionStats()', () => {
    it('returns per-project breakdown', () => {
      const configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj1',
          sessions: [
            [assistantMessage({ input: 100, output: 50 })],
            [assistantMessage({ input: 150, output: 75 })],
          ],
        },
        {
          name: '-Users-greg-proj2',
          sessions: [
            [assistantMessage({ input: 400, output: 200 })],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getSessionStats();

      expect(stats.length).toBe(2);
      const proj1 = stats.find((p) => p.project_path === '/Users/greg/proj1');
      const proj2 = stats.find((p) => p.project_path === '/Users/greg/proj2');
      expect(proj1).toBeDefined();
      expect(proj2).toBeDefined();
      expect(proj1!.session_count).toBe(2);
      expect(proj1!.total_tokens).toBe(375); // 150 + 225
      expect(proj2!.session_count).toBe(1);
      expect(proj2!.total_tokens).toBe(600);
    });

    it('filters by since date', () => {
      const configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj',
          sessions: [
            [
              assistantMessage({ timestamp: '2026-03-01T00:00:00Z', input: 100, output: 50 }),
              assistantMessage({ timestamp: '2026-04-09T00:00:00Z', input: 200, output: 80 }),
            ],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getSessionStats('2026-04-01');

      const proj = stats.find((p) => p.project_path === '/Users/greg/proj');
      expect(proj).toBeDefined();
      expect(proj!.total_tokens).toBe(280); // only the Apr 9 message (200 + 80)
    });

    it('returns empty array when no data', () => {
      const accounts = makeAccountsService([]);
      const service = createUsageService(accounts);
      const stats = service.getSessionStats();

      expect(stats).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 5. getUsageDetails — individual entries with limit
  // -------------------------------------------------------------------------

  describe('getUsageDetails()', () => {
    it('returns individual usage entries', () => {
      const configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-myproject',
          sessions: [
            [
              assistantMessage({ model: 'claude-sonnet-4-5-20250514', input: 100, output: 50, timestamp: '2026-04-09T12:00:00Z' }),
            ],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const entries = service.getUsageDetails();

      expect(entries.length).toBe(1);
      const entry = entries[0];
      expect(entry.project_path).toBe('/Users/greg/myproject');
      expect(entry.model).toBe('claude-sonnet-4-5-20250514');
      expect(entry.input_tokens).toBe(100);
      expect(entry.output_tokens).toBe(50);
      expect(entry.timestamp).toBe('2026-04-09T12:00:00Z');
      expect(typeof entry.cost).toBe('number');
      expect(entry.cost).toBeGreaterThan(0);
    });

    it('respects limit parameter', () => {
      const configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj',
          sessions: [
            [
              assistantMessage({ input: 100, output: 50 }),
              assistantMessage({ input: 200, output: 80 }),
              assistantMessage({ input: 300, output: 100 }),
              assistantMessage({ input: 400, output: 120 }),
              assistantMessage({ input: 500, output: 150 }),
            ],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const entries = service.getUsageDetails(3);

      expect(entries.length).toBe(3);
    });

    it('returns all entries when no limit specified', () => {
      const configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj',
          sessions: [
            [
              assistantMessage({ input: 100, output: 50 }),
              assistantMessage({ input: 200, output: 80 }),
            ],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const entries = service.getUsageDetails();

      expect(entries.length).toBe(2);
    });

    it('returns empty array when no data', () => {
      const accounts = makeAccountsService([]);
      const service = createUsageService(accounts);
      const entries = service.getUsageDetails();

      expect(entries).toEqual([]);
    });

    it('includes session_id derived from filename', () => {
      const configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj',
          sessions: [
            [assistantMessage({ input: 100, output: 50 })],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const entries = service.getUsageDetails();

      expect(entries.length).toBe(1);
      expect(typeof entries[0].session_id).toBe('string');
      expect(entries[0].session_id.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Cost calculation
  // -------------------------------------------------------------------------

  describe('cost calculation', () => {
    it('uses opus pricing for opus model', () => {
      const configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj',
          sessions: [
            [assistantMessage({ model: 'claude-opus-4', input: 1_000_000, output: 1_000_000 })],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      // opus: 15/M input, 75/M output
      const expectedCost = 15 + 75; // = 90
      expect(stats.total_cost).toBeCloseTo(expectedCost, 5);
    });

    it('uses haiku pricing for haiku model', () => {
      const configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj',
          sessions: [
            [assistantMessage({ model: 'claude-haiku-3-5', input: 1_000_000, output: 1_000_000 })],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      // haiku: 0.25/M input, 1.25/M output
      const expectedCost = 0.25 + 1.25; // = 1.5
      expect(stats.total_cost).toBeCloseTo(expectedCost, 5);
    });

    it('uses sonnet pricing for unknown model (default)', () => {
      const configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj',
          sessions: [
            [assistantMessage({ model: 'claude-unknown-model', input: 1_000_000, output: 1_000_000 })],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      // default (sonnet): 3/M input, 15/M output
      const expectedCost = 3 + 15; // = 18
      expect(stats.total_cost).toBeCloseTo(expectedCost, 5);
    });
  });

  // -------------------------------------------------------------------------
  // Current model rates, cache-token pricing, and per-request dedup
  // -------------------------------------------------------------------------

  describe('current model rates, cache pricing, and per-request dedup', () => {
    it('prices opus 4.8 at current rates including cache tokens', () => {
      const configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj',
          sessions: [
            [
              assistantMessage({
                model: 'claude-opus-4-8',
                input: 100,
                output: 200,
                cacheRead: 1000,
                cacheCreation: 500,
              }),
            ],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      // opus-4-8: 5/M input, 25/M output; cache read 0.1x input, cache write(5m) 1.25x input
      const M = 1_000_000;
      const expected =
        100 * (5 / M) + 200 * (25 / M) + 1000 * (5 / M) * 0.1 + 500 * (5 / M) * 1.25;
      expect(stats.total_cost).toBeCloseTo(expected, 10);
    });

    it('counts a multi-line message (same requestId) exactly once', () => {
      const configDir = makeTmp();
      // Two JSONL lines sharing requestId 'req_1' with identical usage — the CLI
      // writes one line per content block for a single billed request, so
      // summing raw lines would double count. Only the last should be kept.
      const line = { ...assistantMessage({ input: 200, output: 100 }), requestId: 'req_1' };
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-proj',
          sessions: [[line, line]],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      expect(stats.total_tokens).toBe(300); // 200 + 100, counted once
    });
  });

  // -------------------------------------------------------------------------
  // Project path decoding
  // -------------------------------------------------------------------------

  describe('project path decoding', () => {
    it('decodes directory name to project path', () => {
      const configDir = makeTmp();
      // directory name: '-Users-greg-projects-myapp'
      // expected path:  '/Users/greg/projects/myapp'
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-projects-myapp',
          sessions: [
            [assistantMessage({ input: 100, output: 50 })],
          ],
        },
      ]);

      const accounts = makeAccountsService([configDir]);
      const service = createUsageService(accounts);
      const stats = service.getUsageStats();

      const proj = stats.by_project.find((p) => p.project_path === '/Users/greg/projects/myapp');
      expect(proj).toBeDefined();
    });
  });

  describe('getStatsByAccount()', () => {
    it('returns per-account stats grouped correctly', () => {
      const dir1 = makeTmpDir();
      const dir2 = makeTmpDir();

      // Account 1 has one project with one session
      const projDir1 = path.join(dir1, 'projects', '-Users-alice-foo');
      fs.mkdirSync(projDir1, { recursive: true });
      writeJsonl(path.join(projDir1, 'session-a.jsonl'), [
        assistantMessage({ model: 'claude-sonnet-4-5-20250514', input: 200, output: 100, timestamp: '2026-04-10T10:00:00Z' }),
      ]);

      // Account 2 has one project with one session
      const projDir2 = path.join(dir2, 'projects', '-Users-bob-bar');
      fs.mkdirSync(projDir2, { recursive: true });
      writeJsonl(path.join(projDir2, 'session-b.jsonl'), [
        assistantMessage({ model: 'claude-opus-4-5-20250514', input: 500, output: 300, timestamp: '2026-04-10T11:00:00Z' }),
      ]);

      const accounts = [
        makeAccount({ id: 1, name: 'Personal', config_dir: dir1, subscription_label: 'max' }),
        makeAccount({ id: 2, name: 'Work', config_dir: dir2, subscription_label: 'pro' }),
      ];
      const svc = createUsageService({
        listAccounts: () => accounts,
        createAccount: () => accounts[0],
        updateAccount: () => {},
        updateSummarySettings: () => {},
        deleteAccount: () => {},
        listPathRules: () => [],
        addPathRule: () => ({ id: 1, account_id: 1, account_name: 'Test', account_engine: 'claude', path_prefix: '/', priority: 0 }),
        removePathRule: () => {},
        resolve: () => ({ claude: null, codex: null }),
        setProjectOverride: () => {},
        listProjectOverrides: () => [],
        explainResolution: () => null,
        discoverAccounts: async () => [],
        scanForNewAccounts: async () => [],
      });

      const result = svc.getStatsByAccount();
      expect(result).toHaveLength(2);

      const personal = result.find((r) => r.account_name === 'Personal');
      const work = result.find((r) => r.account_name === 'Work');

      expect(personal).toBeDefined();
      expect(personal!.account_type).toBe('max');
      expect(personal!.stats.total_sessions).toBe(1);
      expect(personal!.stats.total_tokens).toBe(300); // 200 + 100

      expect(work).toBeDefined();
      expect(work!.account_type).toBe('pro');
      expect(work!.stats.total_sessions).toBe(1);
      expect(work!.stats.total_tokens).toBe(800); // 500 + 300

      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    it('respects date range filter', () => {
      const dir = makeTmpDir();
      const projDir = path.join(dir, 'projects', '-Users-test-proj');
      fs.mkdirSync(projDir, { recursive: true });
      writeJsonl(path.join(projDir, 'session-1.jsonl'), [
        assistantMessage({ input: 100, output: 50, timestamp: '2026-04-01T10:00:00Z' }),
        assistantMessage({ input: 200, output: 100, timestamp: '2026-04-10T10:00:00Z' }),
      ]);

      const accounts = [makeAccount({ id: 1, name: 'Test', config_dir: dir })];
      const svc = createUsageService({
        listAccounts: () => accounts,
        createAccount: () => accounts[0],
        updateAccount: () => {},
        updateSummarySettings: () => {},
        deleteAccount: () => {},
        listPathRules: () => [],
        addPathRule: () => ({ id: 1, account_id: 1, account_name: 'Test', account_engine: 'claude', path_prefix: '/', priority: 0 }),
        removePathRule: () => {},
        resolve: () => ({ claude: null, codex: null }),
        setProjectOverride: () => {},
        listProjectOverrides: () => [],
        explainResolution: () => null,
        discoverAccounts: async () => [],
        scanForNewAccounts: async () => [],
      });

      // Only include April 9-15
      const result = svc.getStatsByAccount('2026-04-09', '2026-04-15');
      expect(result).toHaveLength(1);
      expect(result[0].stats.total_tokens).toBe(300); // only the April 10 entry

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  // -------------------------------------------------------------------------
  // Scrape logging — info entries emitted when usage data is collected
  // -------------------------------------------------------------------------

  describe('scrape logging', () => {
    it('logs an info entry for each account after scanning', () => {
      const configDir = makeTmp();
      buildConfigDir(configDir, [
        {
          name: '-Users-greg-myproject',
          sessions: [
            [assistantMessage({ model: 'claude-sonnet-4-5-20250514', input: 100, output: 50 })],
          ],
        },
      ]);

      const logger = makeFakeLogger();
      const service = createUsageService(makeAccountsService([configDir]), logger);
      service.getUsageStats();

      const infoEntries = logger.getEntries().filter(
        (e) => e.level === 'info' && e.source === 'usage',
      );
      expect(infoEntries.length).toBeGreaterThan(0);

      const scanEntry = infoEntries.find((e) => /scrape/i.test(String(e.message)));
      expect(scanEntry).toBeDefined();
      const metadata = JSON.parse(scanEntry.metadata);
      // The scrape log records the entry COUNT, not the full parsed-entry array.
      // Logging the whole array bloated app_logs on every Usage-tab query.
      expect(metadata.entry_count).toBe(1);
      expect(metadata).not.toHaveProperty('entries');
    });

    it('emits one log entry per account', () => {
      const dir1 = makeTmp();
      const dir2 = makeTmp();
      buildConfigDir(dir1, [{ name: '-Users-greg-p1', sessions: [[assistantMessage({})]] }]);
      buildConfigDir(dir2, [{ name: '-Users-greg-p2', sessions: [[assistantMessage({})]] }]);

      const logger = makeFakeLogger();
      const service = createUsageService(makeAccountsService([dir1, dir2]), logger);
      service.getUsageStats();

      const scrapeEntries = logger.getEntries().filter(
        (e) => e.level === 'info' && e.source === 'usage' && /scrape/i.test(String(e.message)),
      );
      expect(scrapeEntries.length).toBe(2);
    });
  });
});

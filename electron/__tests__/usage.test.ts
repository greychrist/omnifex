import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    is_default: true,
    account_type: 'pro',
    color: null,
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
    deleteAccount: () => {},
    listPathRules: () => [],
    addPathRule: () => ({ id: 1, account_id: 1, account_name: 'Test', path_prefix: '/', priority: 0 }),
    removePathRule: () => {},
    resolve: () => null,
    setProjectOverride: () => {},
    listProjectOverrides: () => [],
    explainResolution: () => null,
    discoverAccounts: async () => [],
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
  // 1. getUsageStats — correct totals from JSONL files
  // -------------------------------------------------------------------------

  describe('getUsageStats()', () => {
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
      // Cost: (300 * 3 + 130 * 15) / 1_000_000 = (900 + 1950) / 1_000_000
      const expectedCost = (300 * 3 + 130 * 15) / 1_000_000;
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
        makeAccount({ id: 1, name: 'Personal', config_dir: dir1, account_type: 'max' }),
        makeAccount({ id: 2, name: 'Work', config_dir: dir2, account_type: 'pro' }),
      ];
      const svc = createUsageService({
        listAccounts: () => accounts,
        createAccount: () => accounts[0],
        updateAccount: () => {},
        deleteAccount: () => {},
        listPathRules: () => [],
        addPathRule: () => ({ id: 1, account_id: 1, account_name: 'Test', path_prefix: '/', priority: 0 }),
        removePathRule: () => {},
        resolve: () => null,
        setProjectOverride: () => {},
        listProjectOverrides: () => [],
        explainResolution: () => null,
        discoverAccounts: async () => [],
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
        deleteAccount: () => {},
        listPathRules: () => [],
        addPathRule: () => ({ id: 1, account_id: 1, account_name: 'Test', path_prefix: '/', priority: 0 }),
        removePathRule: () => {},
        resolve: () => null,
        setProjectOverride: () => {},
        listProjectOverrides: () => [],
        explainResolution: () => null,
        discoverAccounts: async () => [],
      });

      // Only include April 9-15
      const result = svc.getStatsByAccount('2026-04-09', '2026-04-15');
      expect(result).toHaveLength(1);
      expect(result[0].stats.total_tokens).toBe(300); // only the April 10 entry

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});

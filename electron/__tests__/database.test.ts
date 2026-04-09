import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';

describe('database', () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates all required tables', () => {
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);
    expect(names).toContain('accounts');
    expect(names).toContain('account_path_rules');
    expect(names).toContain('project_account_overrides');
    expect(names).toContain('agents');
    expect(names).toContain('agent_runs');
    expect(names).toContain('app_settings');
    expect(names).toContain('app_logs');
  });

  it('agents table has correct columns', () => {
    const info = db.raw.prepare('PRAGMA table_info(agents)').all() as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'name', 'icon', 'system_prompt', 'default_task',
        'model', 'hooks', 'created_at', 'updated_at',
      ])
    );
  });

  it('accounts table has claude_binary column', () => {
    const info = db.raw.prepare('PRAGMA table_info(accounts)').all() as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain('claude_binary');
  });

  it('getSetting and saveSetting work', () => {
    db.saveSetting('theme', 'dark');
    expect(db.getSetting('theme')).toBe('dark');

    db.saveSetting('theme', 'light');
    expect(db.getSetting('theme')).toBe('light');
  });

  it('getSetting returns null for missing key', () => {
    expect(db.getSetting('nonexistent')).toBeNull();
  });
});

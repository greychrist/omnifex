import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createStorageService, type StorageService } from '../services/storage';

describe('storage service', () => {
  let db: Database;
  let storage: StorageService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    storage = createStorageService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('listTables returns all tables with column info', () => {
    const tables = storage.listTables();
    const names = tables.map((t) => t.name);
    expect(names).toContain('app_settings');
    expect(names).toContain('app_logs');
    expect(names).toContain('accounts');

    const settingsTable = tables.find((t) => t.name === 'app_settings')!;
    expect(settingsTable.columns.some((c) => c.name === 'key')).toBe(true);
    expect(settingsTable.columns.some((c) => c.name === 'value')).toBe(true);
  });

  it('readTable returns rows with pagination', () => {
    db.saveSetting('a', '1');
    db.saveSetting('b', '2');
    db.saveSetting('c', '3');

    const page1 = storage.readTable('app_settings', 1, 2);
    expect(page1.rows).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = storage.readTable('app_settings', 2, 2);
    expect(page2.rows).toHaveLength(1);
    expect(page2.total).toBe(3);
  });

  it('insertRow adds a row and readTable reflects it', () => {
    storage.insertRow('app_logs', {
      timestamp: '2024-01-01T00:00:00Z',
      level: 'info',
      source: 'test',
      message: 'inserted row',
    });

    const result = storage.readTable('app_logs', 1, 50);
    expect(result.total).toBe(1);
    expect(result.rows[0].message).toBe('inserted row');
  });

  it('updateRow modifies an existing row', () => {
    db.saveSetting('theme', 'dark');

    storage.updateRow('app_settings', { key: 'theme' }, { value: 'light' });

    const result = storage.readTable('app_settings', 1, 50);
    const row = result.rows.find((r: any) => r.key === 'theme');
    expect(row?.value).toBe('light');
  });

  it('deleteRow removes a row', () => {
    db.saveSetting('delete-me', 'yes');

    storage.deleteRow('app_settings', { key: 'delete-me' });

    const result = storage.readTable('app_settings', 1, 50, undefined);
    expect(result.rows.find((r: any) => r.key === 'delete-me')).toBeUndefined();
  });

  it('executeSql runs arbitrary SQL and returns results', () => {
    db.saveSetting('x', '42');

    const result = storage.executeSql("SELECT key, value FROM app_settings WHERE key = 'x'");
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].key).toBe('x');
    expect(result[0].value).toBe('42');
  });

  it('readTable with searchQuery filters across text columns', () => {
    db.saveSetting('find-me', 'needle_value');
    db.saveSetting('skip-me', 'haystack_value');

    const result = storage.readTable('app_settings', 1, 50, 'find-me');
    expect(result.rows.some((r: any) => r.key === 'find-me')).toBe(true);
    expect(result.rows.some((r: any) => r.key === 'skip-me')).toBe(false);
  });

  it('resetDatabase drops and recreates all tables', () => {
    db.saveSetting('beforeReset', 'value');
    storage.resetDatabase();

    // After reset, database should be empty but tables should still exist
    const result = storage.readTable('app_settings', 1, 50);
    expect(result.total).toBe(0);
  });
});

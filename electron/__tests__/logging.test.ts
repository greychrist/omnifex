import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createLoggingService, type LoggingService } from '../services/logging';

describe('logging service', () => {
  let db: Database;
  let logging: LoggingService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    logging = createLoggingService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('writeBatch inserts entries and query returns them all', () => {
    logging.writeBatch([
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'frontend', message: 'hello' },
      { timestamp: '2024-01-01T00:00:01Z', level: 'error', source: 'frontend', message: 'oops' },
    ]);

    const result = logging.query({});
    expect(result.total).toBe(2);
    expect(result.entries).toHaveLength(2);
  });

  it('query filters by level', () => {
    logging.writeBatch([
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'frontend', message: 'info msg' },
      { timestamp: '2024-01-01T00:00:01Z', level: 'error', source: 'frontend', message: 'error msg' },
      { timestamp: '2024-01-01T00:00:02Z', level: 'warn', source: 'frontend', message: 'warn msg' },
    ]);

    const result = logging.query({ levels: ['error', 'warn'] });
    expect(result.total).toBe(2);
    expect(result.entries.every((e) => ['error', 'warn'].includes(e.level))).toBe(true);
  });

  it('query filters by date range', () => {
    logging.writeBatch([
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'frontend', message: 'old' },
      { timestamp: '2024-06-01T00:00:00Z', level: 'info', source: 'frontend', message: 'mid' },
      { timestamp: '2024-12-31T00:00:00Z', level: 'info', source: 'frontend', message: 'new' },
    ]);

    const result = logging.query({
      since: '2024-02-01T00:00:00Z',
      until: '2024-11-01T00:00:00Z',
    });
    expect(result.total).toBe(1);
    expect(result.entries[0].message).toBe('mid');
  });

  it('query filters by search text', () => {
    logging.writeBatch([
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'frontend', message: 'banana split' },
      { timestamp: '2024-01-01T00:00:01Z', level: 'info', source: 'frontend', message: 'apple pie' },
    ]);

    const result = logging.query({ search: 'banana' });
    expect(result.total).toBe(1);
    expect(result.entries[0].message).toBe('banana split');
  });

  it('query search also matches metadata JSON', () => {
    logging.writeBatch([
      {
        timestamp: '2024-01-01T00:00:00Z',
        level: 'info',
        source: 'frontend',
        message: 'permission decision',
        metadata: JSON.stringify({ toolName: 'Bash', ruleContent: 'git:*' }),
      },
      {
        timestamp: '2024-01-01T00:00:01Z',
        level: 'info',
        source: 'frontend',
        message: 'unrelated event',
        metadata: JSON.stringify({ toolName: 'Read' }),
      },
    ]);

    const result = logging.query({ search: 'git:*' });
    expect(result.total).toBe(1);
    expect(result.entries[0].message).toBe('permission decision');
  });

  it('query search also matches category', () => {
    logging.writeBatch([
      {
        timestamp: '2024-01-01T00:00:00Z',
        level: 'info',
        source: 'frontend',
        category: 'permission',
        message: 'some event',
      },
      {
        timestamp: '2024-01-01T00:00:01Z',
        level: 'info',
        source: 'frontend',
        category: 'session',
        message: 'another event',
      },
    ]);

    const result = logging.query({ search: 'permission' });
    expect(result.total).toBe(1);
    expect(result.entries[0].category).toBe('permission');
  });

  it('query search still matches message when metadata and category are empty', () => {
    logging.writeBatch([
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'frontend', message: 'banana split' },
      { timestamp: '2024-01-01T00:00:01Z', level: 'info', source: 'frontend', message: 'apple pie' },
    ]);

    const result = logging.query({ search: 'apple' });
    expect(result.total).toBe(1);
    expect(result.entries[0].message).toBe('apple pie');
  });

  it('count respects broadened search across message, metadata, and category', () => {
    logging.writeBatch([
      {
        timestamp: '2024-01-01T00:00:00Z',
        level: 'info',
        source: 'frontend',
        category: 'permission',
        message: 'msg a',
      },
      {
        timestamp: '2024-01-01T00:00:01Z',
        level: 'info',
        source: 'frontend',
        message: 'permission thing',
      },
      {
        timestamp: '2024-01-01T00:00:02Z',
        level: 'info',
        source: 'frontend',
        message: 'other',
        metadata: JSON.stringify({ note: 'permission snapshot' }),
      },
      {
        timestamp: '2024-01-01T00:00:03Z',
        level: 'info',
        source: 'frontend',
        message: 'unrelated',
      },
    ]);

    expect(logging.count({ search: 'permission' })).toBe(3);
  });

  it('query supports pagination via limit and offset', () => {
    logging.writeBatch([
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'frontend', message: 'a' },
      { timestamp: '2024-01-01T00:00:01Z', level: 'info', source: 'frontend', message: 'b' },
      { timestamp: '2024-01-01T00:00:02Z', level: 'info', source: 'frontend', message: 'c' },
    ]);

    const page1 = logging.query({ limit: 2, offset: 0 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.total).toBe(3); // total reflects full count, not page

    const page2 = logging.query({ limit: 2, offset: 2 });
    expect(page2.entries).toHaveLength(1);
    expect(page2.total).toBe(3);
  });

  it('query filters by source', () => {
    logging.writeBatch([
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'frontend', message: 'ui log' },
      { timestamp: '2024-01-01T00:00:01Z', level: 'info', source: 'backend', message: 'backend log' },
    ]);

    const result = logging.query({ sources: ['frontend'] });
    expect(result.total).toBe(1);
    expect(result.entries[0].source).toBe('frontend');
  });

  it('writeBatch stores optional fields', () => {
    logging.writeBatch([
      {
        timestamp: '2024-01-01T00:00:00Z',
        level: 'debug',
        source: 'backend',
        category: 'network',
        message: 'fetch started',
        metadata: JSON.stringify({ url: 'https://example.com' }),
      },
    ]);

    const result = logging.query({});
    expect(result.entries[0].category).toBe('network');
    expect(result.entries[0].metadata).toBe(JSON.stringify({ url: 'https://example.com' }));
  });

  // ---------------------------------------------------------------------------
  // count()
  // ---------------------------------------------------------------------------

  describe('count()', () => {
    it('returns 0 when no entries exist', () => {
      expect(logging.count({})).toBe(0);
    });

    it('returns the total count when no filters are applied', () => {
      logging.writeBatch([
        { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'frontend', message: 'a' },
        { timestamp: '2024-01-01T00:00:01Z', level: 'info', source: 'frontend', message: 'b' },
        { timestamp: '2024-01-01T00:00:02Z', level: 'info', source: 'frontend', message: 'c' },
      ]);
      expect(logging.count({})).toBe(3);
    });

    it('accepts the same filter shape as query()', () => {
      logging.writeBatch([
        { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'frontend', message: 'fe1' },
        { timestamp: '2024-01-01T00:00:01Z', level: 'error', source: 'frontend', message: 'fe2' },
        { timestamp: '2024-01-01T00:00:02Z', level: 'error', source: 'backend', message: 'be1' },
      ]);

      expect(logging.count({ levels: ['error'] })).toBe(2);
      expect(logging.count({ sources: ['frontend'] })).toBe(2);
      expect(logging.count({ levels: ['error'], sources: ['backend'] })).toBe(1);
      expect(logging.count({ search: 'fe' })).toBe(2);
    });

    it('ignores limit/offset (count is a total, not a page)', () => {
      logging.writeBatch([
        { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'frontend', message: 'a' },
        { timestamp: '2024-01-01T00:00:01Z', level: 'info', source: 'frontend', message: 'b' },
        { timestamp: '2024-01-01T00:00:02Z', level: 'info', source: 'frontend', message: 'c' },
      ]);
      expect(logging.count({ limit: 1, offset: 0 })).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // prune()
  // ---------------------------------------------------------------------------

  describe('prune()', () => {
    it('deletes all entries when olderThan is undefined and returns the count removed', () => {
      logging.writeBatch([
        { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'frontend', message: 'a' },
        { timestamp: '2024-01-01T00:00:01Z', level: 'info', source: 'frontend', message: 'b' },
      ]);
      expect(logging.prune()).toBe(2);
      expect(logging.count({})).toBe(0);
    });

    it('returns 0 when there is nothing to delete', () => {
      expect(logging.prune()).toBe(0);
    });

    it('accepts an ISO timestamp as olderThan and only deletes entries strictly older', () => {
      logging.writeBatch([
        { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'frontend', message: 'old' },
        { timestamp: '2024-06-01T00:00:00Z', level: 'info', source: 'frontend', message: 'cut' },
        { timestamp: '2024-12-31T00:00:00Z', level: 'info', source: 'frontend', message: 'keep' },
      ]);

      const deleted = logging.prune('2024-06-01T00:00:00Z');
      expect(deleted).toBe(1);

      const remaining = logging.query({});
      expect(remaining.total).toBe(2);
      expect(remaining.entries.map((e) => e.message).sort()).toEqual(['cut', 'keep']);
    });

    it('accepts relative duration strings like "1w" and "1m"', () => {
      const now = Date.now();
      const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
      const fortyDaysAgo = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
      const nowIso = new Date(now).toISOString();

      logging.writeBatch([
        { timestamp: fortyDaysAgo, level: 'info', source: 'frontend', message: 'ancient' },
        { timestamp: tenDaysAgo, level: 'info', source: 'frontend', message: 'middle' },
        { timestamp: nowIso, level: 'info', source: 'frontend', message: 'fresh' },
      ]);

      // "1w" = older than 7 days → deletes "ancient" (40d) AND "middle" (10d)
      const weekDeleted = logging.prune('1w');
      expect(weekDeleted).toBe(2);
      expect(logging.count({})).toBe(1);
      expect(logging.query({}).entries[0].message).toBe('fresh');
    });

    it('"1m" deletes entries older than one month (30 days)', () => {
      const now = Date.now();
      const twentyDaysAgo = new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString();
      const fortyDaysAgo = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
      const nowIso = new Date(now).toISOString();

      logging.writeBatch([
        { timestamp: fortyDaysAgo, level: 'info', source: 'frontend', message: 'ancient' },
        { timestamp: twentyDaysAgo, level: 'info', source: 'frontend', message: 'middle' },
        { timestamp: nowIso, level: 'info', source: 'frontend', message: 'fresh' },
      ]);

      expect(logging.prune('1m')).toBe(1); // only "ancient" is older than 30 days
      expect(logging.count({})).toBe(2);
    });

    it('"1d" deletes entries older than one day', () => {
      const now = Date.now();
      const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
      const halfDayAgo = new Date(now - 12 * 60 * 60 * 1000).toISOString();

      logging.writeBatch([
        { timestamp: twoDaysAgo, level: 'info', source: 'frontend', message: 'old' },
        { timestamp: halfDayAgo, level: 'info', source: 'frontend', message: 'recent' },
      ]);

      expect(logging.prune('1d')).toBe(1);
      expect(logging.count({})).toBe(1);
    });
  });
});

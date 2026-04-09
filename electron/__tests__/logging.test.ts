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
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'app', message: 'hello' },
      { timestamp: '2024-01-01T00:00:01Z', level: 'error', source: 'app', message: 'oops' },
    ]);

    const result = logging.query({});
    expect(result.total).toBe(2);
    expect(result.entries).toHaveLength(2);
  });

  it('query filters by level', () => {
    logging.writeBatch([
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'app', message: 'info msg' },
      { timestamp: '2024-01-01T00:00:01Z', level: 'error', source: 'app', message: 'error msg' },
      { timestamp: '2024-01-01T00:00:02Z', level: 'warn', source: 'app', message: 'warn msg' },
    ]);

    const result = logging.query({ levels: ['error', 'warn'] });
    expect(result.total).toBe(2);
    expect(result.entries.every((e) => ['error', 'warn'].includes(e.level))).toBe(true);
  });

  it('query filters by date range', () => {
    logging.writeBatch([
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'app', message: 'old' },
      { timestamp: '2024-06-01T00:00:00Z', level: 'info', source: 'app', message: 'mid' },
      { timestamp: '2024-12-31T00:00:00Z', level: 'info', source: 'app', message: 'new' },
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
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'app', message: 'banana split' },
      { timestamp: '2024-01-01T00:00:01Z', level: 'info', source: 'app', message: 'apple pie' },
    ]);

    const result = logging.query({ search: 'banana' });
    expect(result.total).toBe(1);
    expect(result.entries[0].message).toBe('banana split');
  });

  it('query supports pagination via limit and offset', () => {
    logging.writeBatch([
      { timestamp: '2024-01-01T00:00:00Z', level: 'info', source: 'app', message: 'a' },
      { timestamp: '2024-01-01T00:00:01Z', level: 'info', source: 'app', message: 'b' },
      { timestamp: '2024-01-01T00:00:02Z', level: 'info', source: 'app', message: 'c' },
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
        source: 'agent',
        category: 'network',
        message: 'fetch started',
        metadata: JSON.stringify({ url: 'https://example.com' }),
      },
    ]);

    const result = logging.query({});
    expect(result.entries[0].category).toBe('network');
    expect(result.entries[0].metadata).toBe(JSON.stringify({ url: 'https://example.com' }));
  });
});

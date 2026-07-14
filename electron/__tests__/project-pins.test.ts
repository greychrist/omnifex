import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createProjectPinsService, type ProjectPinsService } from '../services/project-pins';

describe('project pins service', () => {
  let db: Database;
  let service: ProjectPinsService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    service = createProjectPinsService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('starts with no pins', () => {
    expect(service.list()).toEqual([]);
  });

  it('pins a project and reports it pinned', () => {
    service.setPinned('/Users/me/repo', true);
    expect(service.list()).toEqual(['/Users/me/repo']);
    expect(service.isPinned('/Users/me/repo')).toBe(true);
  });

  it('reports an unpinned project as not pinned', () => {
    expect(service.isPinned('/Users/me/never-pinned')).toBe(false);
  });

  it('unpins a pinned project', () => {
    service.setPinned('/Users/me/repo', true);
    service.setPinned('/Users/me/repo', false);
    expect(service.list()).toEqual([]);
    expect(service.isPinned('/Users/me/repo')).toBe(false);
  });

  it('pinning twice is idempotent (no duplicate rows)', () => {
    service.setPinned('/Users/me/repo', true);
    service.setPinned('/Users/me/repo', true);
    expect(service.list()).toEqual(['/Users/me/repo']);
  });

  it('unpinning a project that was never pinned is a no-op', () => {
    expect(() => { service.setPinned('/Users/me/ghost', false); }).not.toThrow();
    expect(service.list()).toEqual([]);
  });

  it('keeps pins independent across projects', () => {
    service.setPinned('/Users/me/a', true);
    service.setPinned('/Users/me/b', true);
    service.setPinned('/Users/me/a', false);
    expect(service.list()).toEqual(['/Users/me/b']);
  });

  it('persists pins across service instances on the same db', () => {
    service.setPinned('/Users/me/repo', true);
    const reopened = createProjectPinsService(db);
    expect(reopened.isPinned('/Users/me/repo')).toBe(true);
  });
});

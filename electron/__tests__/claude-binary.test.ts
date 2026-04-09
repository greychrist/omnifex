import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createClaudeBinaryService, type ClaudeBinaryService } from '../services/claude-binary';

describe('claude binary service', () => {
  let db: Database;
  let service: ClaudeBinaryService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    service = createClaudeBinaryService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('getPath returns null when no custom path configured', () => {
    expect(service.getPath()).toBeNull();
  });

  it('setPath stores and getPath retrieves', () => {
    service.setPath('/usr/local/bin/claude');
    expect(service.getPath()).toBe('/usr/local/bin/claude');
  });

  it('listInstallations returns an array', () => {
    const installations = service.listInstallations();
    expect(Array.isArray(installations)).toBe(true);
  });

  it('each installation has path and source fields', () => {
    const installations = service.listInstallations();
    for (const inst of installations) {
      expect(inst).toHaveProperty('path');
      expect(inst).toHaveProperty('source');
      expect(typeof inst.path).toBe('string');
    }
  });

  it('findBestBinary returns string or null', () => {
    const best = service.findBestBinary();
    expect(best === null || typeof best === 'string').toBe(true);
  });

  it('findBestBinary prefers custom configured path', () => {
    // Can't reliably test with a real path, but verify logic:
    // If a custom path is set but doesn't exist, falls through to other methods
    service.setPath('/nonexistent/path/claude');
    const best = service.findBestBinary();
    // Should NOT return the nonexistent path
    expect(best).not.toBe('/nonexistent/path/claude');
  });
});

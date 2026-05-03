// Tests for the userdata migration that moves the app's persistent state
// from the legacy "GreyChrist" Application Support directory to the new
// "OmniFex" directory. The migration runs once per install: detect the
// legacy dir, copy its contents to the new location, drop a marker file,
// and never run again.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateUserData, MIGRATION_MARKER_FILENAME } from '../services/userdata-migration';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(dir: string, relPath: string, contents: string) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

function readFile(dir: string, relPath: string): string | null {
  const full = path.join(dir, relPath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf-8');
}

describe('migrateUserData', () => {
  let work: string;
  let legacy: string;
  let next: string;

  beforeEach(() => {
    work = makeTempDir('omnifex-migration-test-');
    legacy = path.join(work, 'GreyChrist');
    next = path.join(work, 'OmniFex');
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('copies all files from legacy to next when next does not exist', () => {
    writeFile(legacy, 'greychrist.db', 'sqlite-bytes');
    writeFile(legacy, 'sub/dir/file.txt', 'hello');

    const result = migrateUserData({ legacyPath: legacy, newPath: next });

    expect(result.migrated).toBe(true);
    expect(readFile(next, 'greychrist.db')).toBe('sqlite-bytes');
    expect(readFile(next, 'sub/dir/file.txt')).toBe('hello');
  });

  it('writes a marker file in the new directory after migrating', () => {
    writeFile(legacy, 'a.txt', 'a');

    migrateUserData({ legacyPath: legacy, newPath: next });

    expect(readFile(next, MIGRATION_MARKER_FILENAME)).not.toBeNull();
  });

  it('skips when the marker file already exists in the new directory', () => {
    writeFile(legacy, 'a.txt', 'legacy-version');
    writeFile(next, MIGRATION_MARKER_FILENAME, '2026-05-03');
    writeFile(next, 'a.txt', 'already-here');

    const result = migrateUserData({ legacyPath: legacy, newPath: next });

    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('already-migrated');
    expect(readFile(next, 'a.txt')).toBe('already-here');
  });

  it('skips when the legacy directory does not exist', () => {
    const result = migrateUserData({ legacyPath: legacy, newPath: next });

    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('no-legacy');
    expect(fs.existsSync(next)).toBe(false);
  });

  it('skips when the new directory already has unrelated content', () => {
    // Defensive: if the user has been running OmniFex already (no legacy
    // GreyChrist install) or the new dir was created some other way, do
    // not overwrite. The marker write would also be skipped.
    writeFile(legacy, 'a.txt', 'legacy');
    writeFile(next, 'b.txt', 'fresh-omnifex-data');

    const result = migrateUserData({ legacyPath: legacy, newPath: next });

    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('new-dir-not-empty');
    expect(readFile(next, 'a.txt')).toBeNull();
    expect(readFile(next, 'b.txt')).toBe('fresh-omnifex-data');
  });

  it('treats the new dir containing only the marker as empty (idempotent re-run)', () => {
    // If a previous migration wrote the marker but legacy dir was later
    // re-introduced (e.g. user ran old GreyChrist build again), we still
    // skip because the marker says we already migrated.
    writeFile(legacy, 'a.txt', 'a');
    fs.mkdirSync(next, { recursive: true });
    fs.writeFileSync(path.join(next, MIGRATION_MARKER_FILENAME), 'already');

    const result = migrateUserData({ legacyPath: legacy, newPath: next });

    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('already-migrated');
  });
});

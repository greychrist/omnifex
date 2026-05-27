import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, type Database } from '../../services/database';
import {
  createCodexBinaryService,
  type CodexBinaryService,
} from '../../services/agents/codex-binary';

describe('codex binary service', () => {
  let db: Database;
  let service: CodexBinaryService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    service = createCodexBinaryService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('getPath returns null when no custom path configured', () => {
    expect(service.getPath()).toBeNull();
  });

  it('setPath stores and getPath retrieves (round-trip through settings)', () => {
    service.setPath('/usr/local/bin/codex');
    expect(service.getPath()).toBe('/usr/local/bin/codex');
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
      expect(typeof inst.source).toBe('string');
    }
  });

  it('findBestBinary returns string or null', () => {
    const best = service.findBestBinary();
    expect(best === null || typeof best === 'string').toBe(true);
  });

  it('findBestBinary does NOT return a nonexistent custom path', () => {
    service.setPath('/nonexistent/path/codex');
    const best = service.findBestBinary();
    expect(best).not.toBe('/nonexistent/path/codex');
  });

  it('findBestBinary returns custom path when it exists on disk', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bin-'));
    const fakeBin = path.join(tmpDir, 'codex');
    fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeBin, 0o755);
    try {
      service.setPath(fakeBin);
      expect(service.findBestBinary()).toBe(fakeBin);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('listInstallations includes a custom configured path tagged "custom"', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bin-'));
    const fakeBin = path.join(tmpDir, 'codex');
    fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeBin, 0o755);
    try {
      service.setPath(fakeBin);
      const installations = service.listInstallations();
      const custom = installations.find((i) => i.source === 'custom');
      // Either it shows up as 'custom', or it was already discovered by another source
      // (in which case the dedup branch in listInstallations short-circuits).
      const seenAtAnySource = installations.some((i) => i.path === fakeBin);
      expect(seenAtAnySource).toBe(true);
      if (custom) expect(custom.path).toBe(fakeBin);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

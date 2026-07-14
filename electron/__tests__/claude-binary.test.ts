import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, type Database } from '../services/database';
import {
  createClaudeBinaryService,
  findBundledSdkBinary,
  type ClaudeBinaryService,
} from '../services/claude-binary';

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

  // listInstallations execSyncs `--version` on every real binary it discovers
  // (which/nvm/standard paths + one per installed VS Code extension copy —
  // observed 9 on a machine with 8 accumulated extension versions). Each probe
  // is fast alone, but under full-suite CPU contention the serial spawns can
  // blow the default 5s budget, so these two get explicit headroom.
  it('listInstallations returns an array', { timeout: 20_000 }, () => {
    const installations = service.listInstallations();
    expect(Array.isArray(installations)).toBe(true);
  });

  it('each installation has path and source fields', { timeout: 20_000 }, () => {
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

  it('findBestBinary returns custom path when it exists on disk', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-'));
    const fakeBin = path.join(tmpDir, 'claude');
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-'));
    const fakeBin = path.join(tmpDir, 'claude');
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
      // If 'custom' label appears, it must point at our fake binary
      if (custom) expect(custom.path).toBe(fakeBin);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('findBundledSdkBinaryAuto', () => {
  it('returns string or null without throwing', async () => {
    const { findBundledSdkBinaryAuto } = await import('../services/claude-binary');
    const result = findBundledSdkBinaryAuto();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('findBundledSdkBinary', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-binary-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function placeBinary(root: string, pkg: string, ext = ''): string {
    const dir = path.join(root, 'node_modules', pkg);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `claude${ext}`);
    fs.writeFileSync(file, '#!/bin/sh\necho fake\n');
    fs.chmodSync(file, 0o755);
    return file;
  }

  it('returns null when no candidate exists', () => {
    const result = findBundledSdkBinary({
      platform: 'darwin',
      arch: 'arm64',
      roots: [path.join(tmpRoot, 'node_modules')],
    });
    expect(result).toBeNull();
  });

  it('finds darwin arm64 binary', () => {
    const expected = placeBinary(tmpRoot, '@anthropic-ai/claude-agent-sdk-darwin-arm64');
    const result = findBundledSdkBinary({
      platform: 'darwin',
      arch: 'arm64',
      roots: [path.join(tmpRoot, 'node_modules')],
    });
    expect(result).toBe(expected);
  });

  it('appends .exe on win32', () => {
    const expected = placeBinary(tmpRoot, '@anthropic-ai/claude-agent-sdk-win32-x64', '.exe');
    const result = findBundledSdkBinary({
      platform: 'win32',
      arch: 'x64',
      roots: [path.join(tmpRoot, 'node_modules')],
    });
    expect(result).toBe(expected);
  });

  it('prefers musl variant on linux when present', () => {
    const expected = placeBinary(tmpRoot, '@anthropic-ai/claude-agent-sdk-linux-x64-musl');
    placeBinary(tmpRoot, '@anthropic-ai/claude-agent-sdk-linux-x64');
    const result = findBundledSdkBinary({
      platform: 'linux',
      arch: 'x64',
      roots: [path.join(tmpRoot, 'node_modules')],
    });
    expect(result).toBe(expected);
  });

  it('falls back to non-musl linux variant when musl missing', () => {
    const expected = placeBinary(tmpRoot, '@anthropic-ai/claude-agent-sdk-linux-x64');
    const result = findBundledSdkBinary({
      platform: 'linux',
      arch: 'x64',
      roots: [path.join(tmpRoot, 'node_modules')],
    });
    expect(result).toBe(expected);
  });

  it('checks roots in order, returning first hit', () => {
    const root1 = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-root1-'));
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-root2-'));
    try {
      const first = placeBinary(root1, '@anthropic-ai/claude-agent-sdk-darwin-arm64');
      placeBinary(root2, '@anthropic-ai/claude-agent-sdk-darwin-arm64');
      const result = findBundledSdkBinary({
        platform: 'darwin',
        arch: 'arm64',
        roots: [path.join(root1, 'node_modules'), path.join(root2, 'node_modules')],
      });
      expect(result).toBe(first);
    } finally {
      fs.rmSync(root1, { recursive: true, force: true });
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });
});

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

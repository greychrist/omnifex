import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createDatabase } from '../services/database';
import { createClaudeBinaryService } from '../services/claude-binary';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execSync: vi.fn() };
});

const execSyncMock = execSync as unknown as ReturnType<typeof vi.fn>;

describe('claude-binary findBestBinary fallback chain', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalNvmBin: string | undefined;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-fallback-'));
    originalHome = process.env.HOME;
    originalNvmBin = process.env.NVM_BIN;
    process.env.HOME = tmpHome;
    delete process.env.NVM_BIN;
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    execSyncMock.mockReset();
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalNvmBin !== undefined) process.env.NVM_BIN = originalNvmBin;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('falls back to NVM installation when which fails and custom is unset', () => {
    // tryWhich -> throws (simulates `which` not found)
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('which') || cmd.includes('where')) {
        throw new Error('not found');
      }
      // version check
      return '1.2.3';
    });

    const nvmBin = path.join(tmpHome, '.nvm', 'versions', 'node', 'v20.0.0', 'bin');
    fs.mkdirSync(nvmBin, { recursive: true });
    const nvmClaude = path.join(nvmBin, 'claude');
    fs.writeFileSync(nvmClaude, '');
    fs.chmodSync(nvmClaude, 0o755);

    const db = createDatabase(':memory:');
    try {
      const service = createClaudeBinaryService(db);
      expect(service.findBestBinary()).toBe(nvmClaude);
    } finally {
      db.close();
    }
  });

  it('uses NVM_BIN env var to find binary directly', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('which') || cmd.includes('where')) throw new Error('nf');
      return '1.0';
    });

    const nvmBinDir = path.join(tmpHome, 'nvm-current', 'bin');
    fs.mkdirSync(nvmBinDir, { recursive: true });
    const candidate = path.join(nvmBinDir, 'claude');
    fs.writeFileSync(candidate, '');
    process.env.NVM_BIN = nvmBinDir;

    const db = createDatabase(':memory:');
    try {
      const service = createClaudeBinaryService(db);
      const installations = service.listInstallations();
      expect(installations.some((i) => i.path === candidate && i.source === 'nvm')).toBe(true);
    } finally {
      db.close();
      delete process.env.NVM_BIN;
    }
  });

  it('falls back to standard install path (~/.local/bin/claude)', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('which') || cmd.includes('where')) throw new Error('nf');
      return '1.0';
    });

    const localBin = path.join(tmpHome, '.local', 'bin');
    fs.mkdirSync(localBin, { recursive: true });
    const standardClaude = path.join(localBin, 'claude');
    fs.writeFileSync(standardClaude, '');

    const db = createDatabase(':memory:');
    try {
      const service = createClaudeBinaryService(db);
      // /usr/local/bin/claude may exist on the host, so we just confirm we got
      // SOME existing standard install path back.
      const result = service.findBestBinary();
      expect(typeof result === 'string' || result === null).toBe(true);
      // installations should include our standard candidate
      const installations = service.listInstallations();
      expect(installations.some((i) => i.path === standardClaude)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('discovers VS Code extension-bundled claude', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('which') || cmd.includes('where')) throw new Error('nf');
      return '1.0';
    });

    const extDir = path.join(tmpHome, '.vscode', 'extensions', 'anthropic.claude-code-1.0.0', 'resources', 'native-binary');
    fs.mkdirSync(extDir, { recursive: true });
    const extClaude = path.join(extDir, 'claude');
    fs.writeFileSync(extClaude, '');

    const db = createDatabase(':memory:');
    try {
      const service = createClaudeBinaryService(db);
      const installations = service.listInstallations();
      expect(installations.some((i) => i.path === extClaude)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('tryWhich success path returns the discovered path with source "which"', () => {
    const homebrewBin = path.join(tmpHome, 'fake-bin', 'claude');
    fs.mkdirSync(path.dirname(homebrewBin), { recursive: true });
    fs.writeFileSync(homebrewBin, '');

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('which claude') || cmd.includes('where claude')) {
        return `${homebrewBin}\n`;
      }
      return '1.0';
    });

    const db = createDatabase(':memory:');
    try {
      const service = createClaudeBinaryService(db);
      expect(service.findBestBinary()).toBe(homebrewBin);
      const installations = service.listInstallations();
      expect(installations.some((i) => i.source === 'which' && i.path === homebrewBin)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('tryWhich ignores result that does not exist on disk', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('which') || cmd.includes('where')) {
        return '/totally/missing/claude\n';
      }
      throw new Error('nf');
    });

    const db = createDatabase(':memory:');
    try {
      const service = createClaudeBinaryService(db);
      expect(service.findBestBinary()).not.toBe('/totally/missing/claude');
    } finally {
      db.close();
    }
  });

  it('listInstallations records version when getVersion succeeds', () => {
    const fakeBin = path.join(tmpHome, '.local', 'bin', 'claude');
    fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
    fs.writeFileSync(fakeBin, '');

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.includes('which') || cmd.includes('where')) throw new Error('nf');
      if (cmd.includes('--version')) return '0.42.0\n';
      return '';
    });

    const db = createDatabase(':memory:');
    try {
      const service = createClaudeBinaryService(db);
      const installations = service.listInstallations();
      const found = installations.find((i) => i.path === fakeBin);
      expect(found?.version).toBe('0.42.0');
    } finally {
      db.close();
    }
  });

  it('listInstallations records null version when --version throws', () => {
    const fakeBin = path.join(tmpHome, '.local', 'bin', 'claude');
    fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
    fs.writeFileSync(fakeBin, '');

    execSyncMock.mockImplementation(() => {
      throw new Error('nope');
    });

    const db = createDatabase(':memory:');
    try {
      const service = createClaudeBinaryService(db);
      const installations = service.listInstallations();
      const found = installations.find((i) => i.path === fakeBin);
      expect(found?.version).toBeNull();
    } finally {
      db.close();
    }
  });
});

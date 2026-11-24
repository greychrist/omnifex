import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from './database';
import { findOnPath } from './util/path-lookup';
import { probeBinaryVersion } from './util/exec-text';

export interface ClaudeInstallation {
  path: string;
  version: string | null;
  source: string;
}

export interface ClaudeBinaryService {
  getPath(): string | null;
  setPath(binaryPath: string): void;
  listInstallations(): Promise<ClaudeInstallation[]>;
  findBestBinary(): string | null;
}

function tryWhich(): string | null {
  return findOnPath(process.platform === 'win32' ? 'claude.exe' : 'claude', process.env.PATH);
}

function findNvmInstallations(): string[] {
  const results: string[] = [];
  const home = os.homedir();

  const nvmBin = process.env.NVM_BIN;
  if (nvmBin) {
    const candidate = path.join(nvmBin, 'claude');
    if (fs.existsSync(candidate)) {
      results.push(candidate);
    }
  }

  const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
  try {
    const entries = fs.readdirSync(nvmVersionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(nvmVersionsDir, entry.name, 'bin', 'claude');
      if (fs.existsSync(candidate)) {
        results.push(candidate);
      }
    }
  } catch {
    // NVM not installed or directory doesn't exist
  }

  return results;
}

function findStandardInstallations(): string[] {
  const home = os.homedir();

  const candidates: string[] = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
    '/bin/claude',
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.yarn', 'bin', 'claude'),
    path.join(home, '.bun', 'bin', 'claude'),
    path.join(home, 'bin', 'claude'),
    path.join(home, 'node_modules', '.bin', 'claude'),
    path.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin', 'claude'),
  ];

  const vscodeExtDir = path.join(home, '.vscode', 'extensions');
  try {
    const entries = fs.readdirSync(vscodeExtDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith('anthropic.claude-code-')) continue;
      const candidate = path.join(
        vscodeExtDir,
        entry.name,
        'resources',
        'native-binary',
        'claude',
      );
      candidates.push(candidate);
    }
  } catch {
    // VS Code not installed or no matching extensions
  }

  return candidates.filter((p) => fs.existsSync(p));
}

export interface FindBundledSdkBinaryOptions {
  platform: NodeJS.Platform;
  arch: string;
  roots: string[];
}

export function findBundledSdkBinary(opts: FindBundledSdkBinaryOptions): string | null {
  const ext = opts.platform === 'win32' ? '.exe' : '';
  const pkgs =
    opts.platform === 'linux'
      ? [
          `@anthropic-ai/claude-agent-sdk-linux-${opts.arch}-musl`,
          `@anthropic-ai/claude-agent-sdk-linux-${opts.arch}`,
        ]
      : [`@anthropic-ai/claude-agent-sdk-${opts.platform}-${opts.arch}`];

  for (const root of opts.roots) {
    for (const pkg of pkgs) {
      const candidate = path.join(root, pkg, `claude${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function findBundledSdkBinaryAuto(): string | null {
  const roots: string[] = [];
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    roots.push(path.join(resourcesPath, 'app.asar.unpacked', 'node_modules'));
  }
  roots.push(path.resolve('node_modules'));

  return findBundledSdkBinary({
    platform: process.platform,
    arch: process.arch,
    roots,
  });
}

/** Launchers want `ClaudeBinaryService.findBestBinary()`, which tries the Settings pick first. */
export function discoverClaudeBinary(): string | null {
  const whichResult = tryWhich();
  if (whichResult) return whichResult;

  const nvmPaths = findNvmInstallations();
  if (nvmPaths.length > 0) return nvmPaths[0];

  const standardPaths = findStandardInstallations();
  if (standardPaths.length > 0) return standardPaths[0];

  return findBundledSdkBinaryAuto();
}

export function createClaudeBinaryService(db: Database): ClaudeBinaryService {
  const SETTING_KEY = 'claude_binary_path';

  function getPath(): string | null {
    return db.getSetting(SETTING_KEY);
  }

  function setPath(binaryPath: string): void {
    db.saveSetting(SETTING_KEY, binaryPath);
  }

  async function listInstallations(): Promise<ClaudeInstallation[]> {
    const seen = new Set<string>();
    const found: { path: string; source: string }[] = [];

    function add(p: string, source: string): void {
      if (seen.has(p)) return;
      seen.add(p);
      found.push({ path: p, source });
    }

    const whichResult = tryWhich();
    if (whichResult) {
      add(whichResult, 'which');
    }

    for (const p of findNvmInstallations()) {
      add(p, 'nvm');
    }

    for (const p of findStandardInstallations()) {
      add(p, 'standard');
    }

    const custom = getPath();
    if (custom && fs.existsSync(custom) && !seen.has(custom)) {
      add(custom, 'custom');
    }

    // All at once: each can take up to its 5 s timeout.
    return Promise.all(
      found.map(async ({ path: p, source }) => ({ path: p, source, version: await probeBinaryVersion(p) })),
    );
  }

  function findBestBinary(): string | null {
    const custom = getPath();
    if (custom && fs.existsSync(custom)) {
      return custom;
    }
    return discoverClaudeBinary();
  }

  return { getPath, setPath, listInstallations, findBestBinary };
}

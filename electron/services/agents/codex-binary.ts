import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from '../database';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface CodexInstallation {
  path: string;
  version: string | null;
  source: string;
}

export interface CodexBinaryService {
  getPath(): string | null;
  setPath(binaryPath: string): void;
  listInstallations(): CodexInstallation[];
  findBestBinary(): string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const EXEC_OPTIONS = {
  timeout: 5000,
  encoding: 'utf-8' as const,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
};

function getVersion(binaryPath: string): string | null {
  try {
    const output = execSync(`"${binaryPath}" --version`, EXEC_OPTIONS);
    return typeof output === 'string' ? output.trim() : null;
  } catch {
    return null;
  }
}

function tryWhich(): string | null {
  const cmd = process.platform === 'win32' ? 'where codex' : 'which codex';
  try {
    const output = execSync(cmd, EXEC_OPTIONS);
    if (typeof output === 'string') {
      const trimmed = output.trim().split('\n')[0].trim();
      if (trimmed && fs.existsSync(trimmed)) {
        return trimmed;
      }
    }
  } catch {
    // not found
  }
  return null;
}

function findNvmInstallations(): string[] {
  const results: string[] = [];
  const home = os.homedir();

  const nvmBin = process.env.NVM_BIN;
  if (nvmBin) {
    const candidate = path.join(nvmBin, 'codex');
    if (fs.existsSync(candidate)) {
      results.push(candidate);
    }
  }

  const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
  try {
    const entries = fs.readdirSync(nvmVersionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(nvmVersionsDir, entry.name, 'bin', 'codex');
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
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    '/usr/bin/codex',
    '/bin/codex',
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.npm-global', 'bin', 'codex'),
    path.join(home, '.yarn', 'bin', 'codex'),
    path.join(home, '.bun', 'bin', 'codex'),
    path.join(home, 'bin', 'codex'),
    path.join(home, 'node_modules', '.bin', 'codex'),
    path.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin', 'codex'),
  ];

  return candidates.filter((p) => fs.existsSync(p));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCodexBinaryService(db: Database): CodexBinaryService {
  const SETTING_KEY = 'codex_binary_path';

  function getPath(): string | null {
    return db.getSetting(SETTING_KEY);
  }

  function setPath(binaryPath: string): void {
    db.saveSetting(SETTING_KEY, binaryPath);
  }

  function listInstallations(): CodexInstallation[] {
    const seen = new Set<string>();
    const installations: CodexInstallation[] = [];

    function add(p: string, source: string): void {
      if (seen.has(p)) return;
      seen.add(p);
      installations.push({ path: p, source, version: getVersion(p) });
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

    return installations;
  }

  function findBestBinary(): string | null {
    const custom = getPath();
    if (custom && fs.existsSync(custom)) {
      return custom;
    }

    const whichResult = tryWhich();
    if (whichResult) {
      return whichResult;
    }

    const nvmPaths = findNvmInstallations();
    if (nvmPaths.length > 0) {
      return nvmPaths[0];
    }

    const standardPaths = findStandardInstallations();
    if (standardPaths.length > 0) {
      return standardPaths[0];
    }

    return null;
  }

  return { getPath, setPath, listInstallations, findBestBinary };
}

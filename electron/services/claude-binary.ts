import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from './database';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ClaudeInstallation {
  path: string;
  version: string | null;
  source: string;
}

export interface ClaudeBinaryService {
  getPath(): string | null;
  setPath(binaryPath: string): void;
  listInstallations(): ClaudeInstallation[];
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

/** Run `binary --version` and return trimmed output, or null on any failure. */
function getVersion(binaryPath: string): string | null {
  try {
    const output = execSync(`"${binaryPath}" --version`, EXEC_OPTIONS);
    return typeof output === 'string' ? output.trim() : null;
  } catch {
    return null;
  }
}

/** Attempt to locate `claude` via `which` (Unix) or `where` (Windows). */
function tryWhich(): string | null {
  const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
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

/** Find claude binaries in NVM-managed node versions. */
function findNvmInstallations(): string[] {
  const results: string[] = [];
  const home = os.homedir();

  // Check NVM_BIN env var first
  const nvmBin = process.env['NVM_BIN'];
  if (nvmBin) {
    const candidate = path.join(nvmBin, 'claude');
    if (fs.existsSync(candidate)) {
      results.push(candidate);
    }
  }

  // Scan $HOME/.nvm/versions/node/*/bin/claude
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

/** Check a list of well-known standard install paths. */
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

  // VS Code extensions: $HOME/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createClaudeBinaryService(db: Database): ClaudeBinaryService {
  const SETTING_KEY = 'claude_binary_path';

  function getPath(): string | null {
    return db.getSetting(SETTING_KEY);
  }

  function setPath(binaryPath: string): void {
    db.saveSetting(SETTING_KEY, binaryPath);
  }

  function listInstallations(): ClaudeInstallation[] {
    const seen = new Set<string>();
    const installations: ClaudeInstallation[] = [];

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
    // 1. Custom configured path — only if it actually exists on disk
    const custom = getPath();
    if (custom && fs.existsSync(custom)) {
      return custom;
    }

    // 2. which / where
    const whichResult = tryWhich();
    if (whichResult) {
      return whichResult;
    }

    // 3. NVM installations (first found)
    const nvmPaths = findNvmInstallations();
    if (nvmPaths.length > 0) {
      return nvmPaths[0];
    }

    // 4. Standard install paths (first found)
    const standardPaths = findStandardInstallations();
    if (standardPaths.length > 0) {
      return standardPaths[0];
    }

    return null;
  }

  return { getPath, setPath, listInstallations, findBestBinary };
}

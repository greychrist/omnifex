import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from '../database';
import { findOnPath } from '../util/path-lookup';
import { probeBinaryVersion } from '../util/exec-text';

export interface CodexInstallation {
  path: string;
  version: string | null;
  source: string;
}

export interface CodexBinaryService {
  getPath(): string | null;
  setPath(binaryPath: string): void;
  listInstallations(): Promise<CodexInstallation[]>;
  findBestBinary(): string | null;
}

/** Found in-process: shelling out to `which` costs a process per lookup. */
function tryWhich(): string | null {
  return findOnPath(process.platform === 'win32' ? 'codex.exe' : 'codex', process.env.PATH);
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

export function createCodexBinaryService(db: Database): CodexBinaryService {
  const SETTING_KEY = 'codex_binary_path';

  function getPath(): string | null {
    return db.getSetting(SETTING_KEY);
  }

  function setPath(binaryPath: string): void {
    db.saveSetting(SETTING_KEY, binaryPath);
  }

  async function listInstallations(): Promise<CodexInstallation[]> {
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

    return Promise.all(
      found.map(async ({ path: p, source }) => ({ path: p, source, version: await probeBinaryVersion(p) })),
    );
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

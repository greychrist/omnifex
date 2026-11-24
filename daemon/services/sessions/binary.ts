import fs from 'node:fs';
import os from 'node:os';
import { discoverClaudeBinary } from '../claude-binary';

export function findSystemClaudeBinary(): string | null {
  return discoverClaudeBinary();
}

export function findSystemCodexBinary(): string | null {
  const candidates = [
    `${os.homedir()}/.local/bin/codex`,
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

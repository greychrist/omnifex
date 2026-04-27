import { execSync } from 'node:child_process';
import fs from 'node:fs';

export interface FindClaudeBinaryDeps {
  which?: () => string | null;
  exists?: (p: string) => boolean;
  fallbacks?: string[];
}

const DEFAULT_FALLBACKS = [
  `${process.env.HOME ?? ''}/.local/bin/claude`,
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
];

export function findClaudeBinary(deps: FindClaudeBinaryDeps = {}): string | null {
  const which = deps.which ?? defaultWhich;
  const exists = deps.exists ?? fs.existsSync;
  const fallbacks = deps.fallbacks ?? DEFAULT_FALLBACKS;

  const w = which();
  if (w && exists(w)) return w;
  for (const p of fallbacks) {
    if (p && exists(p)) return p;
  }
  return null;
}

function defaultWhich(): string | null {
  try {
    const out = execSync('which claude', { encoding: 'utf-8' });
    const trimmed = out.trim().split('\n')[0].trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

// Resolver hook: lets plain Node load this repo's TypeScript the way Vite and
// Vitest do. The electron/ sources use extensionless relative imports under
// `moduleResolution: bundler`, which raw Node ESM rejects. Rather than have
// scripts/ reimplement anything they need (search.ts:70 warns specifically
// that a second copy of the FTS weights would drift unnoticed), we teach the
// loader to try the extensions a bundler would.
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = ['.ts', '.mts', '.tsx', '.js', '.mjs'];

function firstExisting(base) {
  for (const ext of EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
  // A bare directory import resolves to its index, same as the bundler.
  const asPath = fileURLToPath(base);
  if (existsSync(asPath) && statSync(asPath).isDirectory()) {
    for (const ext of EXTENSIONS) {
      const candidate = `${base}/index${ext}`;
      if (existsSync(fileURLToPath(candidate))) return candidate;
    }
  }
  return null;
}

export async function resolve(specifier, context, next) {
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (relative && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    const base = new URL(specifier, context.parentURL).href;
    const hit = firstExisting(base);
    if (hit !== null) return next(hit, context);
  }
  return next(specifier, context);
}

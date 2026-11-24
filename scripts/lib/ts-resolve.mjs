// daemon/ uses extensionless imports under `moduleResolution: bundler`, which raw Node ESM rejects:
// try the extensions a bundler would.
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = ['.ts', '.mts', '.tsx', '.js', '.mjs'];

function firstExisting(base) {
  for (const ext of EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (existsSync(fileURLToPath(candidate))) return candidate;
  }
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

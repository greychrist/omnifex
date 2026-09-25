import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// `claudeBinaryService.getPath()` is only the path saved in Settings — null
// until the user picks one. Anything that launches the CLI must use
// `findBestBinary()`, which honours that pick and otherwise discovers the
// install the Settings page is already showing. Wiring launches to getPath()
// made sign-in fail with "claude binary not found" and made the identity
// probe report every account signed out, for anyone who never touched the
// selector; wiring them to nothing let sessions, the model and command
// catalogs and summaries ignore the selector entirely.

/** The source text of the first `name(...)` call, parens balanced. */
function callText(src: string, name: string): string {
  const start = src.indexOf(`${name}(`);
  if (start === -1) throw new Error(`${name}( not found`);
  let depth = 0;
  for (let i = start + name.length; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name}( is unbalanced`);
}

const FIND_BEST = /\(\)\s*=>\s*claudeBinaryService\.findBestBinary\(\)/;

describe('claude binary wiring in the composition roots', () => {
  for (const root of ['main.ts', 'remote/daemon.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', root), 'utf8');

    it(`${root} never launches from the bare saved setting`, () => {
      expect(src).not.toMatch(/resolveBinary:\s*\(\)\s*=>\s*claudeBinaryService\.getPath\(\)/);
      expect(src).not.toMatch(/claudeBinaryService\.getPath\(\)\s*\?\?/);
      expect(src).not.toMatch(/findSystemClaudeBinary/);
    });

    for (const factory of ['createModelsService', 'createCommandsCatalogService', 'createSummaryQueryRunner']) {
      it(`${root} hands findBestBinary to ${factory}`, () => {
        expect(callText(src, factory)).toMatch(
          new RegExp(`resolveClaudeBinary:\\s*${FIND_BEST.source}`),
        );
      });
    }

    // Positional, so the order is the contract: resolveClaudeBinary, then the
    // CLI-usage recorder (the spend no transcript records). Both roots must
    // pass the recorder — the parameter is optional, so a root that forgot it
    // would compile and silently stop counting that spend.
    it(`${root} hands findBestBinary, then the CLI-usage recorder, to createSessionsService last`, () => {
      expect(callText(src, 'createSessionsService')).toMatch(
        new RegExp(`${FIND_BEST.source},\\s*(//[^\\n]*\\s*)*createCliProcessUsageStore\\(db\\)\\.record,?\\s*\\)$`),
      );
    });
  }
});

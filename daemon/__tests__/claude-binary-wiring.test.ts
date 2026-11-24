import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

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

describe('claude binary wiring in the composition root', () => {
  for (const root of ['remote/daemon.ts']) {
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

    it(`${root} hands findBestBinary to createClaudeAuthService`, () => {
      expect(callText(src, 'createClaudeAuthService')).toMatch(
        new RegExp(`resolveBinary:\\s*${FIND_BEST.source}`),
      );
    });

    it(`${root} hands findBestBinary to createUsageRunnerService`, () => {
      expect(callText(src, 'createUsageRunnerService')).toMatch(
        new RegExp(`findClaudeBinary:\\s*${FIND_BEST.source}`),
      );
    });

    // Positional and optional: a root that omits one still compiles, so the order
    // is the contract.
    it(`${root} hands findBestBinary, the CLI-usage recorder, the auto-recap policy, the bundled mod, then the mod-notifications gate to createSessionsService last`, () => {
      expect(callText(src, 'createSessionsService')).toMatch(
        new RegExp(`${FIND_BEST.source},\\s*(//[^\\n]*\\s*)*createCliProcessUsageStore\\(db\\)\\.record,\\s*\\(\\) => readAutoRecapPolicy\\(\\(key\\) => db\\.getSetting\\(key\\)\\),\\s*\\(\\) => modNotificationsEnabled\\(db\\.getSetting\\(MOD_NOTIFICATIONS_SETTING_KEY\\)\\),?\\s*\\)$`),
      );
    });
  }
});

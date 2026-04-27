import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseUsageOutput } from '../services/usage-runner/parser';

const fixDir = path.join(__dirname, 'fixtures', 'usage-output');

describe('parseUsageOutput fixtures', () => {
  const txts = readdirSync(fixDir).filter((f) => f.endsWith('.txt'));
  for (const txt of txts) {
    const name = txt.replace(/\.txt$/, '');
    it(name, () => {
      const raw = readFileSync(path.join(fixDir, txt), 'utf-8');
      const expected = JSON.parse(
        readFileSync(path.join(fixDir, `${name}.expected.json`), 'utf-8'),
      );
      const result = parseUsageOutput(raw);
      if (expected.ok === false) {
        expect(result.ok).toBe(false);
      } else {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.data).toEqual(expected);
      }
    });
  }
});

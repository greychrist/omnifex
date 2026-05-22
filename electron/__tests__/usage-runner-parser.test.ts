import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseUsageOutput, isUsageOutputComplete } from '../services/usage-runner/parser';

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

describe('isUsageOutputComplete', () => {
  it('accepts a window at 0% usage even when it has no Resets line', () => {
    // Observed in 2026-05-22 real /usage output: when Sonnet usage is 0%,
    // the TUI renders the "Current week (Sonnet only)" header and the
    // "0% used" bar but OMITS the "Resets ..." line entirely (because
    // there's nothing to reset to). The parser already handles this
    // (resets_at_label becomes ''), but the fast-path completeness check
    // was rejecting it, forcing the runner to wait the full
    // usageQuietMs + incompleteParseGraceMs every successful poll.
    const FIXTURE = `
Session
Total cost:             $0.0000
Total duration (API):   0s
Total duration (wall):  58s
Total code changes:     0 lines added, 0 lines removed
Usage:                  0 input, 0 output, 0 cache read, 0 cache write

Current session
6% used
Resets 3:40am (America/New_York)

Current week (all models)
7% used
Resets May 25 at 7pm (America/New_York)

Current week (Sonnet only)
0% used
`;
    expect(isUsageOutputComplete(FIXTURE)).toBe(true);
  });

  it('still rejects a render that is missing a window entirely', () => {
    // The whole point of the check — if Sonnet hasn't been rendered yet at
    // all, we're still in the middle of the async load and must keep
    // waiting. Don't accept this as complete.
    const FIXTURE = `
Session
Total cost:             $0.0000

Current session
6% used
Resets 3:40am (America/New_York)

Current week (all models)
7% used
Resets May 25 at 7pm (America/New_York)
`;
    expect(isUsageOutputComplete(FIXTURE)).toBe(false);
  });

  it('still rejects a non-zero window that is missing its Resets line', () => {
    // 0% with no Resets line is fine (nothing to reset). But a non-zero %
    // with no Resets line means the window is still rendering — keep
    // waiting.
    const FIXTURE = `
Session
Total cost:             $0.0000

Current session
6% used

Current week (all models)
7% used
Resets May 25 at 7pm (America/New_York)

Current week (Sonnet only)
12% used
Resets May 25 at 7pm (America/New_York)
`;
    expect(isUsageOutputComplete(FIXTURE)).toBe(false);
  });
});

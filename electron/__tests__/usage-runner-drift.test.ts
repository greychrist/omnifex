import { describe, it, expect } from 'vitest';
import { collectUsageDriftWarnings, parseUsageOutput } from '../services/usage-runner/parser';

// Mirrors the real Claude Code 2.1.159 `/usage` render captured live on
// 2026-06-02 (session 17% / week 4% / Sonnet 0%). All labels intact — the
// baseline the drift audit must treat as clean.
const HEALTHY = `
Session
Total cost: $0.0000
Total duration (API): 0s
Total duration (wall): 1s
Total code changes: 0 lines added, 0 lines removed
Usage: 0 input, 0 output, 0 cache read, 0 cache write
Current session
17% used
Resets 1:10am (America/New_York)
Current week (all models)
4% used
Resets Jun 8 at 7pm (America/New_York)
Current week (Sonnet only)
0% used
Resets Jun 8 at 7pm (America/New_York)
`;

describe('collectUsageDriftWarnings', () => {
  it('returns no warnings for a healthy current-format render', () => {
    expect(collectUsageDriftWarnings(HEALTHY)).toEqual([]);
  });

  it('flags a session field label that drifted (the silent-zero case)', () => {
    // CLI reworded "Total cost:" → "Total spend:". parseSessionBlock silently
    // returns cost_usd: 0 even though the real value is $12.34 — exactly the
    // failure the audit exists to catch.
    const drifted = HEALTHY.replace('Total cost: $0.0000', 'Total spend: $12.3456');

    // Prove the silent corruption first: the parse "succeeds" with a zero cost.
    const parsed = parseUsageOutput(drifted);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data.session.cost_usd).toBe(0);

    // ...and the audit surfaces it.
    const warns = collectUsageDriftWarnings(drifted);
    expect(warns.some((w) => w.includes('Total cost:'))).toBe(true);
    expect(warns).toHaveLength(1);
  });

  it('flags a window header present but "% used" phrasing drifted', () => {
    const drifted = HEALTHY.replace('17% used', '17% consumed');
    const warns = collectUsageDriftWarnings(drifted);
    expect(warns.some((w) => w.includes('current_session'))).toBe(true);
  });

  it('does not flag a legitimately absent Session block (free-tier / partial render)', () => {
    // No Session header at all — a known-tolerated shape, not drift.
    const partial = `
Current session
17% used
Resets 1:10am (America/New_York)
`;
    expect(collectUsageDriftWarnings(partial)).toEqual([]);
  });

  it('does not flag an absent window (partial render mid-async-load)', () => {
    // Session block intact, but the Sonnet window hasn't rendered yet. Absent
    // window ≠ drifted label; the audit stays quiet so the runner's existing
    // incomplete-parse grace handling owns that case.
    const noSonnet = HEALTHY.replace(
      /Current week \(Sonnet only\)[\s\S]*$/,
      '',
    );
    expect(collectUsageDriftWarnings(noSonnet)).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { collectUsageDriftWarnings, parseUsageOutput } from '../services/usage-runner/parser';

// The real 2.1.159 `/usage` render, all labels intact.
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
    // parseSessionBlock silently returns cost_usd: 0 for a reworded label.
    const drifted = HEALTHY.replace('Total cost: $0.0000', 'Total spend: $12.3456');

    const parsed = parseUsageOutput(drifted);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data.session.cost_usd).toBe(0);

    const warns = collectUsageDriftWarnings(drifted);
    expect(warns.some((w) => w.includes('Total cost:'))).toBe(true);
    expect(warns).toHaveLength(1);
  });

  it("reads 2.1.326's `Estimated cost:` label as the session cost, with no drift warning", () => {
    // 2.1.326 renamed "Total cost:" to "Estimated cost:"; older CLIs still print
    // the original.
    const renamed = HEALTHY.replace('Total cost: $0.0000', 'Estimated cost: $12.3456');
    const parsed = parseUsageOutput(renamed);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data.session.cost_usd).toBeCloseTo(12.3456);
    expect(collectUsageDriftWarnings(renamed)).toEqual([]);
  });

  it('flags a window header present but "% used" phrasing drifted', () => {
    const drifted = HEALTHY.replace('17% used', '17% consumed');
    const warns = collectUsageDriftWarnings(drifted);
    expect(warns.some((w) => w.includes('current_session'))).toBe(true);
  });

  it('does not flag a legitimately absent Session block (free-tier / partial render)', () => {
    const partial = `
Current session
17% used
Resets 1:10am (America/New_York)
`;
    expect(collectUsageDriftWarnings(partial)).toEqual([]);
  });

  it('does not flag an absent window (partial render mid-async-load)', () => {
    const noSonnet = HEALTHY.replace(
      /Current week \(Sonnet only\)[\s\S]*$/,
      '',
    );
    expect(collectUsageDriftWarnings(noSonnet)).toEqual([]);
  });
});

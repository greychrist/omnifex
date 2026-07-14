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

describe('stale (last-known) render detection', () => {
  // Claude Code 2.1.208: when the usage endpoint is rate-limited (or a
  // refresh fails), /usage renders last-known bars with a marker line:
  //   "Showing last-known usage as of <time> (rate limited — try again in a moment)"
  //   "Showing last-known usage as of <time> (could not refresh)"
  // The bars parse normally, but the data is stale and must be flagged so
  // the runner doesn't record it as fresh utilization.
  const WINDOWS = `
Current session
33% used
Resets 9:40am (America/New_York)

Current week (all models)
68% used
Resets 7pm (America/New_York)

Current week (Sonnet only)
6% used
Resets 7pm (America/New_York)
`;

  it('flags the "(could not refresh)" variant as stale', () => {
    const result = parseUsageOutput(
      `Showing last-known usage as of 5:43pm (could not refresh)\n${WINDOWS}`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.stale).toBe(true);
  });

  it('does not flag a normal render', () => {
    const result = parseUsageOutput(WINDOWS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.stale).toBe(false);
  });
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

  it('accepts a window-less (enterprise) render once the tables footer prints', () => {
    // Enterprise/Console accounts have no subscription rate-limit windows, so
    // the TUI never renders the "Current session"/"Current week" headers — it
    // shows a persistent "Loading usage data…" placeholder then the
    // contributing breakdown + ranked tables. The render is complete once the
    // "d to day · w to week" tables footer prints.
    const FIXTURE = `
Session
Total cost: $0.0000

Loading usage data…

What's contributing to your limits usage?

100% of your usage came from subagent-heavy sessions
  Each subagent runs its own requests.

Subagents % of usage
general-purpose 16%

d to day · w to week
`;
    expect(isUsageOutputComplete(FIXTURE)).toBe(true);
  });

  it('keeps waiting on a window-less render before the tables footer prints', () => {
    // Still mid-load: contributing header is up but the local-session scan
    // hasn't finished (no tables footer yet). Don't snapshot a partial render.
    const FIXTURE = `
Session
Total cost: $0.0000

Loading usage data…

What's contributing to your limits usage?

Scanning local sessions…
`;
    expect(isUsageOutputComplete(FIXTURE)).toBe(false);
  });
});

describe('parseUsageOutput — MCP servers table', () => {
  it('parses space-containing MCP server names and isolates the table', () => {
    const FIXTURE = `
Session
Total cost: $0.0000

What's contributing to your limits usage?

Subagents % of usage
general-purpose 16%

MCP servers % of usage
claude.ai Atlassian 3%
some-server 1%
… 4 more

d to day · w to week
`;
    const result = parseUsageOutput(FIXTURE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.mcp_servers.rows).toEqual([
      { name: 'claude.ai Atlassian', pct_used: 3 },
      { name: 'some-server', pct_used: 1 },
    ]);
    expect(result.data.mcp_servers.more_count).toBe(4);
    // The subagents table above must not bleed the MCP rows in.
    expect(result.data.subagents.rows).toEqual([
      { name: 'general-purpose', pct_used: 16 },
    ]);
  });
});

describe('parseUsageOutput contributing — multi-frame buffers', () => {
  // The pty buffer accumulates multiple TUI redraw frames. The first
  // "What's contributing" header can land in an earlier (incomplete) frame,
  // so the contributing slice legitimately spans into the later complete
  // frame to reach the real entries. A 0%-used window renders its bar label
  // as a bare "0% used" line (no leading bar glyph to disqualify it), which
  // otherwise gets mis-read as a contributing headline — injecting a bogus
  // entry. Verified against the live 2.1.159 capture on 2026-06-02.
  const TWO_FRAME = `
Session
Total cost: $0.0000
Total duration (API): 0s
Total duration (wall): 1s
Total code changes: 0 lines added, 0 lines removed
Usage: 0 input, 0 output, 0 cache read, 0 cache write
Current session
████ 17% used
Resets 1:10am (America/New_York)
Current week (all models)
██ 4% used
Resets Jun 8 at 7pm (America/New_York)
Current week (Sonnet only)
0% used
Resets Jun 8 at 7pm (America/New_York)
What's contributing to your limits usage?
Scanning local sessions…

Session
Total cost: $0.0000
Total duration (API): 0s
Total duration (wall): 1s
Total code changes: 0 lines added, 0 lines removed
Usage: 0 input, 0 output, 0 cache read, 0 cache write
Current session
████ 17% used
Resets 1:10am (America/New_York)
Current week (all models)
██ 4% used
Resets Jun 8 at 7pm (America/New_York)
Current week (Sonnet only)
0% used
Resets Jun 8 at 7pm (America/New_York)
What's contributing to your limits usage?
Approximate, based on local sessions on this machine
Last 24h · independent characteristics of your usage

82% of your usage came from subagent-heavy sessions
Each subagent runs its own requests.

51% of your usage was at >150k context
Longer sessions are more expensive even when cached.
`;

  it('does not inject a bogus "0% used" entry from a later frame', () => {
    const result = parseUsageOutput(TWO_FRAME);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const headlines = result.data.contributing.map((c) => c.headline);
    // The bar-less window label must never appear as a contributing headline.
    expect(headlines).not.toContain('0% used');
    // The two real entries survive intact.
    expect(headlines).toEqual([
      '82% of your usage came from subagent-heavy sessions',
      '51% of your usage was at >150k context',
    ]);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripAnsi } from '../services/usage-runner/ansi';
import { parseUsageOutput } from '../services/usage-runner/parser';

/**
 * A real `/usage` render captured from Claude Code 2.1.236 through a pty
 * sized exactly as `usage-runner` sizes its own (200 cols), with the size
 * set before the child ever ran so no SIGWINCH re-render pollutes it.
 *
 * The CLI paints this screen with a DIFFING renderer: after the first full
 * paint it re-emits only the cells whose contents changed, stepping over the
 * unchanged ones with cursor-positioning escapes (`ESC[<n>G`, `ESC[<n>C`,
 * `ESC[<n>B`). Those stepped-over cells still hold their characters on a real
 * screen — which is why this fixture is the regression test that a linear
 * escape stripper cannot pass and a screen-grid replay can.
 */
const RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures/usage-2.1.236-render.raw'),
  'utf8',
);

describe('real 2.1.236 /usage render', () => {
  const text = stripAnsi(RAW);

  it('does not drop characters that the diffing renderer stepped over', () => {
    // Every one of these arrived mangled under the linear stripper:
    // "/ mnifex-rele se", "mc -atlassian", "these ind p nd t characteristi s".
    expect(text).toContain('/omnifex-release');
    expect(text).toContain('mcp-atlassian');
    expect(text).toContain('general-purpose');
    expect(text).toContain('these are independent characteristics of your usage, not a breakdown');
    expect(text).toContain('count toward your limit');
  });

  it('parses every ranked-table row name intact', () => {
    const r = parseUsageOutput(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.skills.rows.map((x) => x.name)).toEqual([
      '/superpowers:systematic-deb…',
      '/commit',
      '/omnifex-release',
      '/deploy-to-dev',
      '/resolve-ticket',
      '/merge-to-main',
      '/work-on-ticket',
    ]);
    expect(r.data.subagents.rows).toEqual([{ name: 'general-purpose', pct_used: 6 }]);
    expect(r.data.plugins.rows).toEqual([{ name: 'superpowers', pct_used: 16 }]);
    expect(r.data.mcp_servers.rows).toEqual([{ name: 'mcp-atlassian', pct_used: 1 }]);
  });

  it('keeps every rate-limit window the CLI rendered, including per-model ones', () => {
    const r = parseUsageOutput(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 2.1.236 renders a `Current week (Fable)` bar alongside the two classic
    // windows. The old `Current week (Son…)` header regex matched only Sonnet,
    // so this window was silently dropped from the popover and never reached
    // rate-limits storage.
    expect(r.data.windows.map((w) => w.label)).toEqual([
      'current_session',
      'week_all_models',
      'week_fable',
    ]);
    expect(r.data.windows.find((w) => w.label === 'week_fable')?.pct_used).toBe(0);
  });

  it('reads the session block and the contributing narrative', () => {
    const r = parseUsageOutput(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.session.wall_duration_s).toBeGreaterThan(0);
    expect(r.data.contributing).toHaveLength(5);
    expect(r.data.contributing[1].detail).toContain('so make sure it is intentional.');
  });
});

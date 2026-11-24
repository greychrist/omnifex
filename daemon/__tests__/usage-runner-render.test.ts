import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripAnsi } from '../services/usage-runner/ansi';
import { parseUsageOutput } from '../services/usage-runner/parser';

/**
 * A real `/usage` render from Claude Code 2.1.236, through a pty sized as
 * usage-runner sizes its own (200 cols) before the child ran. The CLI's
 * diffing renderer steps over unchanged cells with cursor moves, so only a
 * screen-grid replay reads it correctly.
 */
const RAW = fs.readFileSync(
  path.join(__dirname, 'fixtures/usage-2.1.236-render.raw'),
  'utf8',
);

describe('real 2.1.236 /usage render', () => {
  const text = stripAnsi(RAW);

  it('does not drop characters that the diffing renderer stepped over', () => {
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

// A real 2.1.306 render, captured with scripts/probe-usage-runner.ts.
describe('real 2.1.306 /usage render', () => {
  const text = stripAnsi(fs.readFileSync(
    path.join(__dirname, 'fixtures/usage-2.1.306-render.raw'),
    'utf8',
  ));

  it('carries the fix hint ahead of the period keys', () => {
    expect(text).toMatch(/^\s*f to fix 1 of 2 · d to day · w to week\s*$/m);
  });

  it('parses each one-line recommendation as its own entry', () => {
    const r = parseUsageOutput(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.contributing).toEqual([
      { headline: '29% Trim ~/Repos/personal/omnifex/CLAUDE.md · 7k tokens per request', detail: '' },
      { headline: '14% Start fresh when you switch tasks · run /clear', detail: '' },
    ]);
  });

  it('keeps the last ranked table bounded above the footer', () => {
    const r = parseUsageOutput(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.mcp_servers.rows).toEqual([{ name: 'omnifex-brain', pct_used: 1 }]);
    expect(r.data.mcp_servers.more_count).toBeNull();
    expect(r.data.windows.map((w) => w.label)).toEqual(['current_session', 'week_all_models', 'week_fable']);
  });
});

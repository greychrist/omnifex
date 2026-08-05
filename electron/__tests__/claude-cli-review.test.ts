import { describe, it, expect } from 'vitest';
import {
  REVIEWED_CLI_VERSION,
  parseCliVersion,
  compareCliVersions,
  createClaudeCliReviewService,
} from '../services/claude-cli-review';

describe('parseCliVersion', () => {
  it('strips the product suffix the CLI prints', () => {
    // `claude --version` prints e.g. "2.1.222 (Claude Code)".
    expect(parseCliVersion('2.1.222 (Claude Code)')).toBe('2.1.222');
  });

  it('accepts a bare version string', () => {
    expect(parseCliVersion('2.1.222')).toBe('2.1.222');
  });

  it('tolerates surrounding whitespace and newlines', () => {
    expect(parseCliVersion('  2.1.222 (Claude Code)\n')).toBe('2.1.222');
  });

  it('returns null for output with no version in it', () => {
    expect(parseCliVersion('command not found')).toBeNull();
    expect(parseCliVersion('')).toBeNull();
    expect(parseCliVersion(null)).toBeNull();
    expect(parseCliVersion(undefined)).toBeNull();
  });
});

describe('compareCliVersions', () => {
  it('orders by numeric segment, not lexicographically', () => {
    // The trap: '2.1.9' > '2.1.100' under string comparison.
    expect(compareCliVersions('2.1.100', '2.1.9')).toBeGreaterThan(0);
    expect(compareCliVersions('2.1.9', '2.1.100')).toBeLessThan(0);
  });

  it('reports equality for identical versions', () => {
    expect(compareCliVersions('2.1.222', '2.1.222')).toBe(0);
  });

  it('compares major and minor ahead of patch', () => {
    expect(compareCliVersions('3.0.0', '2.9.999')).toBeGreaterThan(0);
    expect(compareCliVersions('2.2.0', '2.1.999')).toBeGreaterThan(0);
  });

  it('treats missing trailing segments as zero', () => {
    expect(compareCliVersions('2.1', '2.1.0')).toBe(0);
    expect(compareCliVersions('2.1', '2.1.1')).toBeLessThan(0);
  });
});

describe('createClaudeCliReviewService', () => {
  const svc = (raw: string | null) =>
    createClaudeCliReviewService({ cliVersionFn: () => raw });

  it('flags an installed CLI newer than the reviewed watermark', () => {
    const status = svc('99.0.0 (Claude Code)').getStatus();
    expect(status.installed_version).toBe('99.0.0');
    expect(status.reviewed_version).toBe(REVIEWED_CLI_VERSION);
    expect(status.unreviewed).toBe(true);
  });

  it('does not flag when the installed CLI matches the watermark', () => {
    const status = svc(`${REVIEWED_CLI_VERSION} (Claude Code)`).getStatus();
    expect(status.unreviewed).toBe(false);
  });

  it('does not flag when the installed CLI is BEHIND the watermark', () => {
    // A user on an older CLI has nothing for us to review — the changelog
    // for versions they don't run is not actionable here.
    const status = svc('1.0.0 (Claude Code)').getStatus();
    expect(status.installed_version).toBe('1.0.0');
    expect(status.unreviewed).toBe(false);
  });

  it('does not flag when the CLI cannot be located or probed', () => {
    // No binary → nothing to compare. Silence beats a false alarm.
    const status = svc(null).getStatus();
    expect(status.installed_version).toBeNull();
    expect(status.unreviewed).toBe(false);
  });

  it('does not flag on unparseable version output', () => {
    const status = svc('claude: command not found').getStatus();
    expect(status.installed_version).toBeNull();
    expect(status.unreviewed).toBe(false);
  });

  it('re-probes on every call so an in-place CLI upgrade is picked up', () => {
    // The user can `npm i -g @anthropic-ai/claude-code` while OmniFex is
    // running; a version cached at construction would go stale until restart.
    const versions = ['2.0.0 (Claude Code)', '99.0.0 (Claude Code)'];
    let i = 0;
    const service = createClaudeCliReviewService({
      cliVersionFn: () => versions[Math.min(i++, versions.length - 1)],
    });
    expect(service.getStatus().unreviewed).toBe(false);
    expect(service.getStatus().unreviewed).toBe(true);
  });

  it('survives a probe that throws', () => {
    const service = createClaudeCliReviewService({
      cliVersionFn: () => {
        throw new Error('spawn ENOENT');
      },
    });
    expect(service.getStatus()).toMatchObject({
      installed_version: null,
      unreviewed: false,
    });
  });
});

describe('REVIEWED_CLI_VERSION', () => {
  it('is a plain numeric version, not the raw --version output', () => {
    // Bumping this by pasting `claude --version` verbatim would break every
    // comparison; parseCliVersion is not applied to the constant.
    expect(REVIEWED_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

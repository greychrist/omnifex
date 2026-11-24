import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import {
  REVIEWED_CLI_VERSION,
  parseCliVersion,
  compareCliVersions,
  createClaudeCliReviewService,
  isOmnifexRepo,
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

  // `?? 0` on both sides, or a two-segment version compares as NaN.
  it('pads either side, whichever is shorter', () => {
    expect(compareCliVersions('2.1', '2.1.5')).toBeLessThan(0);
    expect(compareCliVersions('2.1.5', '2.1')).toBeGreaterThan(0);
  });

  it('treats missing trailing segments as zero', () => {
    expect(compareCliVersions('2.1', '2.1.0')).toBe(0);
    expect(compareCliVersions('2.1', '2.1.1')).toBeLessThan(0);
  });
});

describe('createClaudeCliReviewService', () => {
  const svc = (raw: string | null) =>
    createClaudeCliReviewService({ cliVersionFn: () => raw });

  it('flags an installed CLI newer than the reviewed watermark', async () => {
    const status = await svc('99.0.0 (Claude Code)').getStatus();
    expect(status.installed_version).toBe('99.0.0');
    expect(status.reviewed_version).toBe(REVIEWED_CLI_VERSION);
    expect(status.unreviewed).toBe(true);
  });

  it('does not flag when the installed CLI matches the watermark', async () => {
    const status = await svc(`${REVIEWED_CLI_VERSION} (Claude Code)`).getStatus();
    expect(status.unreviewed).toBe(false);
  });

  it('does not flag when the installed CLI is BEHIND the watermark', async () => {
    const status = await svc('1.0.0 (Claude Code)').getStatus();
    expect(status.installed_version).toBe('1.0.0');
    expect(status.unreviewed).toBe(false);
  });

  it('does not flag when the CLI cannot be located or probed', async () => {
    const status = await svc(null).getStatus();
    expect(status.installed_version).toBeNull();
    expect(status.unreviewed).toBe(false);
  });

  it('does not flag on unparseable version output', async () => {
    const status = await svc('claude: command not found').getStatus();
    expect(status.installed_version).toBeNull();
    expect(status.unreviewed).toBe(false);
  });

  it('re-probes on every call so an in-place CLI upgrade is picked up', async () => {
    const versions = ['2.0.0 (Claude Code)', '99.0.0 (Claude Code)'];
    let i = 0;
    const service = createClaudeCliReviewService({
      cliVersionFn: () => versions[Math.min(i++, versions.length - 1)],
    });
    expect((await service.getStatus()).unreviewed).toBe(false);
    expect((await service.getStatus()).unreviewed).toBe(true);
  });

  it('awaits an async probe', async () => {
    const service = createClaudeCliReviewService({
      cliVersionFn: async () => '99.0.0 (Claude Code)',
    });
    expect(await service.getStatus()).toMatchObject({ installed_version: '99.0.0', unreviewed: true });
    expect((await service.runUpdate()).from).toBe('99.0.0');
  });

  it('survives an async probe that rejects', async () => {
    const service = createClaudeCliReviewService({
      cliVersionFn: () => Promise.reject(new Error('spawn ENOENT')),
    });
    expect(await service.getStatus()).toMatchObject({ installed_version: null, unreviewed: false });
  });

  it('survives a probe that throws', async () => {
    const service = createClaudeCliReviewService({
      cliVersionFn: () => {
        throw new Error('spawn ENOENT');
      },
    });
    expect(await service.getStatus()).toMatchObject({
      installed_version: null,
      unreviewed: false,
    });
  });
});

describe('createClaudeCliReviewService — checked_version', () => {
  const svc = (installed: string, stored: string | null) =>
    createClaudeCliReviewService({
      cliVersionFn: () => `${installed} (Claude Code)`,
      checkedVersionFn: () => stored,
    });

  it('falls back to the built-in watermark when nothing is stored', async () => {
    const status = await svc('99.0.0', null).getStatus();
    expect(status.checked_version).toBe(REVIEWED_CLI_VERSION);
    expect(status.reviewed_version).toBe(REVIEWED_CLI_VERSION);
    expect(status.unreviewed).toBe(true);
  });

  it('falls back when no lookup is wired at all', async () => {
    const status = await createClaudeCliReviewService({
      cliVersionFn: () => '99.0.0',
    }).getStatus();
    expect(status.checked_version).toBe(REVIEWED_CLI_VERSION);
  });

  it('clears the drift flag once the installed release is marked checked', async () => {
    const status = await svc('99.0.0', '99.0.0').getStatus();
    expect(status.checked_version).toBe('99.0.0');
    expect(status.unreviewed).toBe(false);
    expect(status.reviewed_version).toBe(REVIEWED_CLI_VERSION);
  });

  it('flags again when a newer release than the checked one is installed', async () => {
    const status = await svc('99.0.1', '99.0.0').getStatus();
    expect(status.unreviewed).toBe(true);
  });

  it('never lets a stale stored value drop below the built-in watermark', async () => {
    const status = await svc(REVIEWED_CLI_VERSION, '1.0.0').getStatus();
    expect(status.checked_version).toBe(REVIEWED_CLI_VERSION);
    expect(status.unreviewed).toBe(false);
  });

  it('ignores an unparseable stored value', async () => {
    const status = await svc('99.0.0', 'garbage').getStatus();
    expect(status.checked_version).toBe(REVIEWED_CLI_VERSION);
    expect(status.unreviewed).toBe(true);
  });

  it('survives a lookup that throws', async () => {
    const status = await createClaudeCliReviewService({
      cliVersionFn: () => '99.0.0',
      checkedVersionFn: () => { throw new Error('db closed'); },
    }).getStatus();
    expect(status.checked_version).toBe(REVIEWED_CLI_VERSION);
  });
});

describe('isOmnifexRepo', () => {
  it('recognises this checkout by its package.json name', () => {
    expect(isOmnifexRepo(path.resolve(__dirname, '..', '..'))).toBe(true);
  });

  it('rejects a directory with no package.json', () => {
    expect(isOmnifexRepo(path.resolve(__dirname))).toBe(false);
  });

  it('rejects a directory that does not exist', () => {
    expect(isOmnifexRepo('/no/such/place/at/all')).toBe(false);
  });
});

describe('createClaudeCliReviewService — repo_dir resolution', () => {
  const svc = (opts: {
    override?: string | null;
    candidates?: string[] | (() => string[]);
    repos?: string[];
    exists?: string[];
  }) =>
    createClaudeCliReviewService({
      cliVersionFn: () => '99.0.0 (Claude Code)',
      repoDirOverrideFn: () => opts.override ?? null,
      repoCandidatesFn: () =>
        typeof opts.candidates === 'function' ? opts.candidates() : (opts.candidates ?? []),
      dirExistsFn: (d) => (opts.exists ?? opts.repos ?? []).includes(d),
      isOmnifexRepoFn: (d) => (opts.repos ?? []).includes(d),
    });

  it('prefers the configured override over discovery', async () => {
    const status = await svc({
      override: '/somewhere/else',
      exists: ['/somewhere/else'],
      candidates: ['/repos/omnifex'],
      repos: ['/repos/omnifex'],
    }).getStatus();
    expect(status.repo_dir).toBe('/somewhere/else');
  });

  it('falls through to discovery when the override no longer exists', async () => {
    const status = await svc({
      override: '/gone',
      exists: ['/repos/omnifex'],
      candidates: ['/repos/other', '/repos/omnifex'],
      repos: ['/repos/omnifex'],
    }).getStatus();
    expect(status.repo_dir).toBe('/repos/omnifex');
  });

  it('picks the first candidate that is an OmniFex checkout', async () => {
    const status = await svc({
      candidates: ['/repos/win', '/repos/omnifex', '/repos/omnifex-fork'],
      repos: ['/repos/omnifex', '/repos/omnifex-fork'],
    }).getStatus();
    expect(status.repo_dir).toBe('/repos/omnifex');
  });

  it('reports null when nothing matches, so the warning stays plain text', async () => {
    const status = await svc({ candidates: ['/repos/win'], repos: [] }).getStatus();
    expect(status.repo_dir).toBeNull();
  });

  it('reports null when no resolution deps are wired at all', async () => {
    const status = await createClaudeCliReviewService({
      cliVersionFn: () => '99.0.0 (Claude Code)',
    }).getStatus();
    expect(status.repo_dir).toBeNull();
  });

  it('caches a positive discovery instead of re-scanning every call', async () => {
    const candidates = vi.fn(() => ['/repos/omnifex']);
    const service = svc({ candidates, repos: ['/repos/omnifex'] });
    await service.getStatus();
    await service.getStatus();
    expect(candidates).toHaveBeenCalledTimes(1);
  });

  it('re-scans after a miss, so cloning the repo does not need a restart', async () => {
    const candidates = vi.fn(() => ['/repos/win']);
    const service = svc({ candidates, repos: [] });
    await service.getStatus();
    await service.getStatus();
    expect(candidates).toHaveBeenCalledTimes(2);
  });

  it('survives a candidate source that rejects', async () => {
    const service = createClaudeCliReviewService({
      cliVersionFn: () => '99.0.0 (Claude Code)',
      repoCandidatesFn: () => Promise.reject(new Error('projects unavailable')),
    });
    const status = await service.getStatus();
    expect(status.repo_dir).toBeNull();
    expect(status.unreviewed).toBe(true);
  });
});

describe('REVIEWED_CLI_VERSION', () => {
  it('is a plain numeric version, not the raw --version output', () => {
    expect(REVIEWED_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('createClaudeCliReviewService — latest published release', () => {
  const svc = (installed: string | null, latest: string | null) =>
    createClaudeCliReviewService({
      cliVersionFn: () => installed,
      latestVersionFn: () => Promise.resolve(latest),
    });

  it('reports a newer published release as an available upgrade', async () => {
    const status = await svc('2.1.241 (Claude Code)', '2.1.246').getStatus();
    expect(status.latest_version).toBe('2.1.246');
    expect(status.upgrade_available).toBe(true);
  });

  it('does not offer an upgrade when the installed CLI is already current', async () => {
    const status = await svc('2.1.246 (Claude Code)', '2.1.246').getStatus();
    expect(status.upgrade_available).toBe(false);
  });

  it('does not offer a downgrade when the installed CLI leads the registry', async () => {
    const status = await svc('2.1.250 (Claude Code)', '2.1.246').getStatus();
    expect(status.upgrade_available).toBe(false);
  });

  it('stays silent when the registry cannot be reached', async () => {
    const status = await svc('2.1.241 (Claude Code)', null).getStatus();
    expect(status.latest_version).toBeNull();
    expect(status.upgrade_available).toBe(false);
  });

  it('survives a registry lookup that rejects', async () => {
    const status = await createClaudeCliReviewService({
      cliVersionFn: () => '2.1.241 (Claude Code)',
      latestVersionFn: () => Promise.reject(new Error('ENOTFOUND')),
    }).getStatus();
    expect(status.latest_version).toBeNull();
    expect(status.upgrade_available).toBe(false);
    expect(status.installed_version).toBe('2.1.241');
  });

  it('cannot offer an upgrade when the installed version is unknown', async () => {
    const status = await svc(null, '2.1.246').getStatus();
    expect(status.upgrade_available).toBe(false);
    expect(status.latest_version).toBe('2.1.246');
  });

  it('reports nulls rather than throwing when no lookup is wired', async () => {
    const status = await createClaudeCliReviewService({
      cliVersionFn: () => '2.1.241 (Claude Code)',
    }).getStatus();
    expect(status.latest_version).toBeNull();
    expect(status.upgrade_available).toBe(false);
  });

  it('leaves the review dot keyed on the installed binary, not the registry', async () => {
    const status = await svc('2.1.241 (Claude Code)', '99.0.0').getStatus();
    expect(status.upgrade_available).toBe(true);
    expect(status.unreviewed).toBe(
      compareCliVersions('2.1.241', REVIEWED_CLI_VERSION) > 0,
    );
  });

  it('re-checks on every call so an upgrade landing mid-session is picked up', async () => {
    const latestFn = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('2.1.246')
      .mockResolvedValueOnce('2.1.247');
    const service = createClaudeCliReviewService({
      cliVersionFn: () => '2.1.241 (Claude Code)',
      latestVersionFn: latestFn,
    });

    expect((await service.getStatus()).latest_version).toBe('2.1.246');
    expect((await service.getStatus()).latest_version).toBe('2.1.247');
  });
});

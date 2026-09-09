/**
 * The DEFAULT I/O adapters in claude-cli-review.
 *
 * `claude-cli-review.test.ts` drives the service with every probe injected, so
 * it never reaches the production `execSync` / `execFile` / `fetch` / `statSync`
 * implementations those deps default to. Those defaults are the half that
 * actually touches the machine — a broken one fails silently, because every
 * failure path here deliberately degrades to `null` rather than throwing.
 *
 * Kept in its own file because covering them needs `vi.mock('node:child_process')`
 * at module scope, and the sibling suite must keep the real module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

import { execSync, execFile } from 'node:child_process';
import {
  probeCliVersion,
  execCliUpdate,
  fetchLatestCliVersion,
  createClaudeCliReviewService,
} from '../services/claude-cli-review';

const execSyncMock = vi.mocked(execSync);
const execFileMock = vi.mocked(execFile);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('probeCliVersion', () => {
  it('returns the trimmed --version output', () => {
    execSyncMock.mockReturnValue('2.1.266 (Claude Code)\n' as never);
    expect(probeCliVersion('/bin/claude')).toBe('2.1.266 (Claude Code)');
  });

  // Quoted because a version manager can put the binary under a path with
  // spaces; unquoted, /bin/sh -c would split it into two arguments.
  it('quotes the binary path and asks only for --version', () => {
    execSyncMock.mockReturnValue('2.1.266' as never);
    probeCliVersion('/Applications/My Tools/claude');
    expect(execSyncMock.mock.calls[0][0]).toBe('"/Applications/My Tools/claude" --version');
  });

  it('never spawns when the binary could not be located', () => {
    expect(probeCliVersion(null)).toBeNull();
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  // Whitespace-only output is indistinguishable from no answer, and an empty
  // string would parse to a null version anyway — collapse it at the source.
  it('reports null for empty output', () => {
    execSyncMock.mockReturnValue('   \n' as never);
    expect(probeCliVersion('/bin/claude')).toBeNull();
  });

  // A missing binary, a non-zero exit and the 5s timeout all arrive as a throw.
  // None of them may propagate: this feeds a status popover, not a session.
  it('swallows a throwing probe rather than failing the popover', () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('ETIMEDOUT');
    });
    expect(probeCliVersion('/bin/claude')).toBeNull();
  });
});

describe('execCliUpdate', () => {
  /** Drive the execFile callback the module registered. */
  function settle(err: Error | null, stdout = '', stderr = '') {
    const cb = execFileMock.mock.calls[0][3] as unknown as (
      e: Error | null,
      o: string,
      s: string,
    ) => void;
    cb(err, stdout, stderr);
  }

  it('runs the CLI\'s own `update` subcommand under the given config dir', async () => {
    const p = execCliUpdate('/bin/claude', '/cfg/work');
    expect(execFileMock.mock.calls[0][0]).toBe('/bin/claude');
    expect(execFileMock.mock.calls[0][1]).toEqual(['update']);
    const opts = execFileMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/cfg/work');
    settle(null, 'Updated to 2.1.266\n');
    await expect(p).resolves.toBe('Updated to 2.1.266');
  });

  it('rejects without spawning when the binary could not be located', async () => {
    await expect(execCliUpdate(null, '/cfg/work')).rejects.toThrow('claude binary not found');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  // The actionable text ("npm global folder isn't writable") is on the CLI's
  // own streams; err.message is just "Command failed" and would bury it.
  it('rejects with the CLI\'s stderr, not the generic exec error', async () => {
    const p = execCliUpdate('/bin/claude', '/cfg/work');
    settle(new Error('Command failed'), '', "Can't auto-update: npm global folder isn't writable\n");
    await expect(p).rejects.toThrow("Can't auto-update: npm global folder isn't writable");
  });

  it('falls back to stdout when a failure wrote nothing to stderr', async () => {
    const p = execCliUpdate('/bin/claude', '/cfg/work');
    settle(new Error('Command failed'), 'lock held by another process\n', '');
    await expect(p).rejects.toThrow('lock held by another process');
  });

  it('falls back to the exec error when the CLI wrote nothing at all', async () => {
    const p = execCliUpdate('/bin/claude', '/cfg/work');
    settle(new Error('spawn ENOENT'), '', '');
    await expect(p).rejects.toThrow('spawn ENOENT');
  });

  // `claude update` reports "already up to date" on stderr with a zero exit.
  it('resolves with stderr when a success wrote nothing to stdout', async () => {
    const p = execCliUpdate('/bin/claude', '/cfg/work');
    settle(null, '', 'Already up to date.\n');
    await expect(p).resolves.toBe('Already up to date.');
  });
});

describe('fetchLatestCliVersion', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ok = (body: unknown) => ({ ok: true, json: async () => body });

  it('reads the `latest` dist-tag', async () => {
    fetchMock.mockResolvedValue(ok({ latest: '2.1.266', stable: '2.1.231' }));
    await expect(fetchLatestCliVersion()).resolves.toBe('2.1.266');
  });

  // `latest`, not `stable` — they disagree, and the native installer's
  // self-update tracks `latest`. Reporting `stable` would tell a user they
  // were current while their own binary had moved past it.
  it('prefers `latest` over `stable` when they disagree', async () => {
    fetchMock.mockResolvedValue(ok({ stable: '2.1.231', latest: '2.1.266' }));
    await expect(fetchLatestCliVersion()).resolves.toBe('2.1.266');
  });

  it('reports null on a non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ latest: '2.1.266' }) });
    await expect(fetchLatestCliVersion()).resolves.toBeNull();
  });

  // A proxy serving an HTML error page parses to an object with no `latest`.
  it('reports null when the payload carries no string `latest`', async () => {
    fetchMock.mockResolvedValue(ok({ latest: 42 }));
    await expect(fetchLatestCliVersion()).resolves.toBeNull();
  });

  it('reports null when the registry is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(fetchLatestCliVersion()).resolves.toBeNull();
  });

  // In-flight de-duplication, and only that: the promise is released in a
  // `finally`, so the NEXT check really re-fetches. A time-based cache would
  // make a button labelled "Check for Upgrade" lie.
  it('shares one request between concurrent callers, then re-fetches', async () => {
    fetchMock.mockResolvedValue(ok({ latest: '2.1.266' }));
    const [a, b] = await Promise.all([fetchLatestCliVersion(), fetchLatestCliVersion()]);
    expect(a).toBe('2.1.266');
    expect(b).toBe('2.1.266');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await fetchLatestCliVersion();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// The default `dirExists`, reached only when a caller wires no `dirExistsFn`.
// Exercised through the override path because that is the one branch that asks
// the filesystem whether a user-configured directory is still there.
describe('repo_dir resolution with the real filesystem probe', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-cli-review-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const svc = (override: string) =>
    createClaudeCliReviewService({
      cliVersionFn: () => '2.1.266 (Claude Code)',
      repoDirOverrideFn: () => override,
      repoCandidatesFn: () => [],
      // dirExistsFn deliberately NOT injected — that is the point of this suite.
      isOmnifexRepoFn: () => false,
    });

  it('accepts an override that exists on disk', async () => {
    const status = await svc(tmp).getStatus();
    expect(status.repo_dir).toBe(tmp);
  });

  it('rejects an override that has been deleted', async () => {
    const status = await svc(path.join(tmp, 'gone')).getStatus();
    expect(status.repo_dir).toBeNull();
  });

  // A file is not a directory. `statSync` succeeds on it, so an `existsSync`
  // check here would wrongly accept it.
  it('rejects an override that names a file', async () => {
    const file = path.join(tmp, 'package.json');
    fs.writeFileSync(file, '{}');
    const status = await svc(file).getStatus();
    expect(status.repo_dir).toBeNull();
  });
});

describe('runUpdate with no runner wired', () => {
  const svc = (accounts: { name: string; configDir: string }[]) =>
    createClaudeCliReviewService({
      cliVersionFn: () => '2.1.266 (Claude Code)',
      claudeAccountsFn: () => accounts,
      // runUpdateFn deliberately absent.
    });

  // Reporting success having spawned nothing is the one outcome worse than an
  // error: the popover would claim the CLI was updated and the drift dot would
  // clear on a lie.
  it('throws rather than reporting a silent success', async () => {
    await expect(svc([{ name: 'Work', configDir: '/cfg/work' }]).runUpdate()).rejects.toThrow(
      /no runUpdateFn wired/,
    );
  });

  // With no accounts there is genuinely nothing to run, so that stays quiet.
  it('returns an empty result when there are no accounts to run under', async () => {
    const res = await svc([]).runUpdate();
    expect(res).toEqual({ from: '2.1.266', to: '2.1.266', upgraded: false, accounts: [] });
  });

  // Same outcome when the caller wired no account source at all, rather than
  // one that returns nothing — this is the pre-accounts wiring shape.
  it('returns an empty result when no account source is wired', async () => {
    const res = await createClaudeCliReviewService({
      cliVersionFn: () => '2.1.266 (Claude Code)',
    }).runUpdate();
    expect(res.accounts).toEqual([]);
    expect(res.upgraded).toBe(false);
  });
});

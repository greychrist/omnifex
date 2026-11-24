/**
 * The DEFAULT I/O adapters in claude-cli-review.
 *
 * `claude-cli-review.test.ts` drives the service with every probe injected, so
 * it never reaches the production `execFileSync` / `execFile` / `fetch` / `statSync`
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
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

import { execFileSync, execFile } from 'node:child_process';
import {
  probeCliVersion,
  execCliUpdate,
  fetchLatestCliVersion,
  createClaudeCliReviewService,
} from '../services/claude-cli-review';

const execFileSyncMock = vi.mocked(execFileSync);
const execFileMock = vi.mocked(execFile);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('probeCliVersion', () => {
  /** Settle the async execFile the probe makes: stdout, or a thrown error. */
  function answer(result: string | Error) {
    execFileMock.mockImplementation(((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      process.nextTick(() => (result instanceof Error ? cb(result, '', '') : cb(null, result, '')));
      return { stdin: { end() {} } };
    }) as never);
  }

  it('returns the trimmed --version output', async () => {
    answer('2.1.266 (Claude Code)\n');
    expect(await probeCliVersion('/bin/claude')).toBe('2.1.266 (Claude Code)');
  });

  // Async: this runs on every status check, and a sync spawn with a 5s timeout
  // froze every live session's stream while it ran.
  it('never spawns synchronously', async () => {
    answer('2.1.266');
    await probeCliVersion('/bin/claude');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  // No shell: a version manager can put the binary under a path with spaces,
  // and the path goes to execFile whole rather than through /bin/sh -c.
  it('runs the binary directly and asks only for --version', async () => {
    answer('2.1.266');
    await probeCliVersion('/Applications/My Tools/claude');
    expect(execFileMock.mock.calls[0][0]).toBe('/Applications/My Tools/claude');
    expect(execFileMock.mock.calls[0][1]).toEqual(['--version']);
  });

  it('never spawns when the binary could not be located', async () => {
    expect(await probeCliVersion(null)).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  // Whitespace-only output is indistinguishable from no answer, and an empty
  // string would parse to a null version anyway — collapse it at the source.
  it('reports null for empty output', async () => {
    answer('   \n');
    expect(await probeCliVersion('/bin/claude')).toBeNull();
  });

  // A missing binary, a non-zero exit and the 5s timeout all arrive as an error.
  // None of them may propagate: this feeds a status popover, not a session.
  it('swallows a failing probe rather than failing the popover', async () => {
    answer(new Error('ETIMEDOUT'));
    expect(await probeCliVersion('/bin/claude')).toBeNull();
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

  const NATIVE = '/Users/me/.local/share/claude/versions/2.1.326';
  const NPM = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js';
  const ok = (body: unknown) => ({ ok: true, json: async () => body });
  const text = (body: string) => ({ ok: true, text: async () => body });
  const urlOf = (call: number) => String(fetchMock.mock.calls[call][0]);

  describe('native install', () => {
    // `claude update` on a native install reads the channel the official
    // install.sh reads, and npm runs ahead of it: 2.1.327 was on npm hours
    // before this channel, so the popover offered an update that `claude
    // update` answered with "up to date".
    it('reads the native release channel, not npm', async () => {
      fetchMock.mockResolvedValue(text('2.1.327\n'));
      await expect(fetchLatestCliVersion(NATIVE)).resolves.toBe('2.1.327');
      expect(urlOf(0)).toBe('https://downloads.claude.ai/claude-code-releases/latest');
    });

    // An unknown install location is not evidence of npm, and native is the
    // installer Anthropic ships today.
    it('treats an unknown or missing binary path as native', async () => {
      fetchMock.mockResolvedValue(text('2.1.327'));
      await fetchLatestCliVersion(null);
      await fetchLatestCliVersion('/usr/local/bin/claude');
      expect(urlOf(0)).toContain('downloads.claude.ai');
      expect(urlOf(1)).toContain('downloads.claude.ai');
    });

    // A captive portal or proxy answers 200 with HTML.
    it('reports null when the body is not a version', async () => {
      fetchMock.mockResolvedValue(text('<html>login</html>'));
      await expect(fetchLatestCliVersion(NATIVE)).resolves.toBeNull();
    });

    it('reports null on a non-OK response', async () => {
      fetchMock.mockResolvedValue({ ok: false, text: async () => '2.1.327' });
      await expect(fetchLatestCliVersion(NATIVE)).resolves.toBeNull();
    });
  });

  describe('npm install', () => {
    it('reads the `latest` dist-tag', async () => {
      fetchMock.mockResolvedValue(ok({ latest: '2.1.266', stable: '2.1.231' }));
      await expect(fetchLatestCliVersion(NPM)).resolves.toBe('2.1.266');
      expect(urlOf(0)).toContain('registry.npmjs.org');
    });

    it('reports null on a non-OK response', async () => {
      fetchMock.mockResolvedValue({ ok: false, json: async () => ({ latest: '2.1.266' }) });
      await expect(fetchLatestCliVersion(NPM)).resolves.toBeNull();
    });

    // A proxy serving an HTML error page parses to an object with no `latest`.
    it('reports null when the payload carries no string `latest`', async () => {
      fetchMock.mockResolvedValue(ok({ latest: 42 }));
      await expect(fetchLatestCliVersion(NPM)).resolves.toBeNull();
    });
  });

  it('reports null when the source is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(fetchLatestCliVersion(NATIVE)).resolves.toBeNull();
    await expect(fetchLatestCliVersion(NPM)).resolves.toBeNull();
  });

  // In-flight de-duplication, and only that: the promise is released in a
  // `finally`, so the NEXT check really re-fetches. A time-based cache would
  // make a button labelled "Check for Upgrade" lie.
  it('shares one request between concurrent callers, then re-fetches', async () => {
    fetchMock.mockResolvedValue(text('2.1.266'));
    const [a, b] = await Promise.all([fetchLatestCliVersion(NATIVE), fetchLatestCliVersion(NATIVE)]);
    expect(a).toBe('2.1.266');
    expect(b).toBe('2.1.266');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await fetchLatestCliVersion(NATIVE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Sharing is per source: an npm caller must not receive the native answer.
  it('does not share a request across sources', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('npmjs') ? ok({ latest: '2.1.327' }) : text('2.1.326'));
    const [native, npm] = await Promise.all([fetchLatestCliVersion(NATIVE), fetchLatestCliVersion(NPM)]);
    expect(native).toBe('2.1.326');
    expect(npm).toBe('2.1.327');
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

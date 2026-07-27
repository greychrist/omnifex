import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readOauthIdentity,
  probeAuthStatus,
  emailsMatch,
  classifyIdentity,
  watchOauthIdentity,
} from '../services/account-identity';

function tmpConfigDir(contents?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-identity-'));
  if (contents !== undefined) {
    fs.writeFileSync(path.join(dir, '.claude.json'), contents, 'utf8');
  }
  return dir;
}

describe('readOauthIdentity', () => {
  it('extracts the oauth identity from <configDir>/.claude.json', () => {
    const dir = tmpConfigDir(
      JSON.stringify({
        numStartups: 5,
        oauthAccount: {
          emailAddress: 'gpchristie@gmail.com',
          displayName: 'Greg',
          organizationName: "gpchristie@gmail.com's Organization",
          organizationType: 'claude_max',
        },
      }),
    );
    expect(readOauthIdentity(dir)).toEqual({
      email: 'gpchristie@gmail.com',
      displayName: 'Greg',
      organizationName: "gpchristie@gmail.com's Organization",
      organizationType: 'claude_max',
    });
  });

  it('returns nulls for fields the CLI omitted but still reports the email', () => {
    const dir = tmpConfigDir(
      JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }),
    );
    expect(readOauthIdentity(dir)).toEqual({
      email: 'a@example.com',
      displayName: null,
      organizationName: null,
      organizationType: null,
    });
  });

  it('returns null when the file is missing', () => {
    expect(readOauthIdentity(tmpConfigDir())).toBeNull();
  });

  it('returns null when the file is malformed JSON instead of throwing', () => {
    expect(readOauthIdentity(tmpConfigDir('{ not json'))).toBeNull();
  });

  it('returns null when the file has no oauthAccount key (logged out)', () => {
    expect(readOauthIdentity(tmpConfigDir(JSON.stringify({ numStartups: 5 })))).toBeNull();
  });

  it('returns null when oauthAccount is not an object', () => {
    expect(readOauthIdentity(tmpConfigDir(JSON.stringify({ oauthAccount: 'nope' })))).toBeNull();
  });

  it('returns null when the JSON root is not an object', () => {
    expect(readOauthIdentity(tmpConfigDir(JSON.stringify(['a'])))).toBeNull();
  });

  it('returns null for a nonexistent directory', () => {
    expect(readOauthIdentity('/tmp/omnifex-does-not-exist-xyz')).toBeNull();
  });

  it('returns null for an empty configDir argument', () => {
    expect(readOauthIdentity('')).toBeNull();
  });
});

describe('probeAuthStatus', () => {
  const LOGGED_IN = JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'gpchristie@gmail.com',
    orgId: '1f46',
    orgName: "gpchristie@gmail.com's Organization",
    subscriptionType: 'max',
  });

  it('parses the CLI JSON and passes CLAUDE_CONFIG_DIR through', () => {
    let seenEnv: NodeJS.ProcessEnv | null = null;
    let seenArgs: string[] = [];
    let seenBin = '';
    const status = probeAuthStatus('/tmp/.claude-personal', {
      resolveBinary: () => '/usr/local/bin/claude',
      exec: (bin, args, env) => {
        seenBin = bin;
        seenArgs = args;
        seenEnv = env;
        return LOGGED_IN;
      },
    });
    expect(seenBin).toBe('/usr/local/bin/claude');
    expect(seenArgs).toEqual(['auth', 'status', '--json']);
    expect(seenEnv!.CLAUDE_CONFIG_DIR).toBe('/tmp/.claude-personal');
    expect(status).toEqual({
      loggedIn: true,
      email: 'gpchristie@gmail.com',
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      orgName: "gpchristie@gmail.com's Organization",
      subscriptionType: 'max',
    });
  });

  it('reports logged out when the CLI says so', () => {
    const status = probeAuthStatus('/tmp/x', {
      resolveBinary: () => '/usr/local/bin/claude',
      exec: () => JSON.stringify({ loggedIn: false }),
    });
    expect(status.loggedIn).toBe(false);
    expect(status.email).toBeNull();
  });

  it('reports logged out rather than throwing on non-JSON stdout', () => {
    const status = probeAuthStatus('/tmp/x', {
      resolveBinary: () => '/usr/local/bin/claude',
      exec: () => 'command not found',
    });
    expect(status.loggedIn).toBe(false);
  });

  it('reports logged out when stdout parses to a non-object', () => {
    const status = probeAuthStatus('/tmp/x', {
      resolveBinary: () => '/usr/local/bin/claude',
      exec: () => '42',
    });
    expect(status.loggedIn).toBe(false);
  });

  it('reports logged out rather than throwing when the spawn fails', () => {
    const status = probeAuthStatus('/tmp/x', {
      resolveBinary: () => '/usr/local/bin/claude',
      exec: () => {
        throw new Error('ENOENT');
      },
    });
    expect(status.loggedIn).toBe(false);
  });

  it('reports logged out when no binary can be resolved', () => {
    const status = probeAuthStatus('/tmp/x', { resolveBinary: () => null });
    expect(status.loggedIn).toBe(false);
  });
});

describe('watchOauthIdentity', () => {
  function writeIdentity(dir: string, email: string): void {
    // Atomic rewrite (tmp + rename) — the same shape the CLI and OmniFex's own
    // scratch-cwd helper use. A file-targeted watcher would detach here, which
    // is exactly why the watcher must target the directory.
    const tmp = path.join(dir, '.claude.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ oauthAccount: { emailAddress: email } }), 'utf8');
    fs.renameSync(tmp, path.join(dir, '.claude.json'));
  }

  it('fires when .claude.json is rewritten atomically', async () => {
    const dir = tmpConfigDir(JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }));
    const onChange = vi.fn();
    const sub = watchOauthIdentity(dir, onChange);

    writeIdentity(dir, 'b@example.com');

    await vi.waitFor(() => { expect(onChange).toHaveBeenCalled(); }, { timeout: 3000 });
    sub.dispose();
  });

  // macOS FSEvents names `.claude.json` in the event stream even when an
  // unrelated file in the same dir was written, so the watcher cannot filter
  // on filename alone. The real contract is value-based: no identity change,
  // no callback.
  it('does not fire for unrelated writes in the same dir', async () => {
    const dir = tmpConfigDir(JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }));
    const onChange = vi.fn();
    const sub = watchOauthIdentity(dir, onChange);

    fs.writeFileSync(path.join(dir, 'settings.json'), '{}', 'utf8');
    await new Promise((r) => setTimeout(r, 500));

    expect(onChange).not.toHaveBeenCalled();
    sub.dispose();
  });

  it('does not fire when .claude.json is rewritten with the SAME account', async () => {
    const dir = tmpConfigDir(JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }));
    const onChange = vi.fn();
    const sub = watchOauthIdentity(dir, onChange);

    writeIdentity(dir, 'a@example.com');
    await new Promise((r) => setTimeout(r, 500));

    expect(onChange).not.toHaveBeenCalled();
    sub.dispose();
  });

  it('fires when the account is signed out entirely', async () => {
    const dir = tmpConfigDir(JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }));
    const onChange = vi.fn();
    const sub = watchOauthIdentity(dir, onChange);

    const tmp = path.join(dir, '.claude.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify({ numStartups: 3 }), 'utf8');
    fs.renameSync(tmp, path.join(dir, '.claude.json'));

    await vi.waitFor(() => { expect(onChange).toHaveBeenCalled(); }, { timeout: 3000 });
    sub.dispose();
  });

  it('stops firing after dispose', async () => {
    const dir = tmpConfigDir(JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }));
    const onChange = vi.fn();
    const sub = watchOauthIdentity(dir, onChange);
    sub.dispose();

    writeIdentity(dir, 'c@example.com');
    await new Promise((r) => setTimeout(r, 400));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('returns a disposable no-op for an unwatchable dir instead of throwing', () => {
    const onChange = vi.fn();
    expect(() => {
      const sub = watchOauthIdentity('/tmp/omnifex-nonexistent-watch-xyz', onChange);
      sub.dispose();
    }).not.toThrow();
  });

  it('dispose is idempotent', () => {
    const dir = tmpConfigDir('{}');
    const sub = watchOauthIdentity(dir, vi.fn());
    expect(() => { sub.dispose(); sub.dispose(); }).not.toThrow();
  });
});

describe('classifyIdentity', () => {
  it('reports verified when the detected address matches the expectation', () => {
    expect(
      classifyIdentity({
        accountExists: true,
        expected: 'work@example.com',
        detected: 'WORK@example.com',
      }),
    ).toBe('verified');
  });

  it('reports mismatch when a different account is signed in', () => {
    expect(
      classifyIdentity({
        accountExists: true,
        expected: 'work@example.com',
        detected: 'personal@example.com',
      }),
    ).toBe('mismatch');
  });

  it('reports signed-out when an expectation exists but nobody is signed in', () => {
    expect(
      classifyIdentity({ accountExists: true, expected: 'work@example.com', detected: null }),
    ).toBe('signed-out');
  });

  it('reports unverified when the account opted out of checking', () => {
    expect(
      classifyIdentity({ accountExists: true, expected: null, detected: 'anyone@example.com' }),
    ).toBe('unverified');
    expect(
      classifyIdentity({ accountExists: true, expected: '   ', detected: null }),
    ).toBe('unverified');
  });

  // This is the state that used to be silent: no account row owns the config
  // dir, so nothing can be checked. Collapsing it into 'unverified' would let
  // a routing bug masquerade as a deliberate opt-out.
  it('reports unknown-account when no account owns the config dir', () => {
    expect(
      classifyIdentity({ accountExists: false, expected: null, detected: null }),
    ).toBe('unknown-account');
    expect(
      classifyIdentity({
        accountExists: false,
        expected: 'work@example.com',
        detected: 'work@example.com',
      }),
    ).toBe('unknown-account');
  });
});

describe('emailsMatch', () => {
  it('is case-insensitive and trims', () => {
    expect(emailsMatch('  Greg@Example.COM ', 'greg@example.com')).toBe(true);
  });

  it('does not fold gmail dots or plus-addresses', () => {
    expect(emailsMatch('g.p@gmail.com', 'gp@gmail.com')).toBe(false);
    expect(emailsMatch('gp+work@gmail.com', 'gp@gmail.com')).toBe(false);
  });

  it('treats null/undefined/empty as non-matching', () => {
    expect(emailsMatch(null, 'a@b.c')).toBe(false);
    expect(emailsMatch('a@b.c', undefined)).toBe(false);
    expect(emailsMatch('', '')).toBe(false);
    expect(emailsMatch('   ', 'a@b.c')).toBe(false);
  });
});

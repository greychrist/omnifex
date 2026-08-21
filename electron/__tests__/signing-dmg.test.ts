import { describe, it, expect, vi } from 'vitest';

import {
  developerIdIdentities,
  dmgArtifacts,
  pickSigningIdentity,
  notarizeDmg,
} from '../../signing/dmg';

// Real `security find-identity -v -p codesigning` output shape.
const SECURITY_OUTPUT = `
  1) 1F00CF6B4CF8877953FC3EF9F6683D4E21E2EC91 "GreyChrist Local Sign"
  2) 279B44B5C6093641BC2E69799BEED79CF711E43B "Apple Development: greg@example.com (C9Z3X7N4Y2)"
  3) D0D6513996D38B9EBF0FDAF3B5F86878706E4138 "Developer ID Application: Gregory Christie (37YG3HV4BV)"
     3 valid identities found
`;

describe('developerIdIdentities', () => {
  it('picks out only Developer ID Application certs', () => {
    expect(developerIdIdentities(SECURITY_OUTPUT)).toEqual([
      'Developer ID Application: Gregory Christie (37YG3HV4BV)',
    ]);
  });

  it('ignores Apple Development and self-signed certs', () => {
    const out = developerIdIdentities(SECURITY_OUTPUT).join(' ');
    expect(out).not.toContain('Apple Development');
    expect(out).not.toContain('GreyChrist Local Sign');
  });

  it('returns every Developer ID cert when a team holds more than one', () => {
    const two = `${SECURITY_OUTPUT}\n  4) AAAA "Developer ID Application: Other Co (ZZZZZZZZZZ)"`;
    expect(developerIdIdentities(two)).toHaveLength(2);
  });

  it('returns nothing when no Developer ID cert is installed', () => {
    expect(developerIdIdentities('  0 valid identities found')).toEqual([]);
  });
});

describe('pickSigningIdentity', () => {
  it('prefers an explicit APPLE_SIGNING_IDENTITY', () => {
    expect(pickSigningIdentity(['a', 'b'], 'explicit')).toBe('explicit');
  });

  it('uses the sole installed Developer ID cert', () => {
    expect(pickSigningIdentity(['only-one'], undefined)).toBe('only-one');
  });

  // Same discipline as resolve(): don't guess between equally valid candidates.
  it('refuses to guess between multiple certs', () => {
    expect(() => pickSigningIdentity(['a', 'b'], undefined)).toThrow(/APPLE_SIGNING_IDENTITY/);
  });

  it('fails with an actionable message when none is installed', () => {
    expect(() => pickSigningIdentity([], undefined)).toThrow(/Developer ID Application/);
  });
});

describe('dmgArtifacts', () => {
  it('selects only .dmg paths across make results', () => {
    const results = [
      { artifacts: ['/out/OmniFex.dmg', '/out/OmniFex.zip'] },
      { artifacts: ['/out/other.zip'] },
      { artifacts: ['/out/Second.DMG'] },
    ];
    expect(dmgArtifacts(results)).toEqual(['/out/OmniFex.dmg', '/out/Second.DMG']);
  });

  it('tolerates a make result with no artifacts', () => {
    expect(dmgArtifacts([{ artifacts: [] }, {}])).toEqual([]);
  });
});

describe('notarizeDmg', () => {
  function deps() {
    const run = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'security') return SECURITY_OUTPUT;
      return '';
    });
    return { run, log: vi.fn() };
  }

  it('signs, submits, and staples — in that order', async () => {
    const d = deps();
    await notarizeDmg('/out/OmniFex.dmg', { keychainProfile: 'omnifex-notary' }, d);

    const calls = d.run.mock.calls.filter(([cmd]) => cmd !== 'security');
    expect(calls[0][0]).toBe('codesign');
    expect(calls[1][1]).toContain('submit');
    expect(calls[2][1]).toContain('staple');
  });

  it('signs the dmg with the resolved Developer ID and a secure timestamp', async () => {
    const d = deps();
    await notarizeDmg('/out/OmniFex.dmg', { keychainProfile: 'omnifex-notary' }, d);

    const [, args] = d.run.mock.calls.find(([cmd]) => cmd === 'codesign')!;
    expect(args).toContain('--sign');
    expect(args).toContain('Developer ID Application: Gregory Christie (37YG3HV4BV)');
    expect(args).toContain('--timestamp');
    expect(args).toContain('/out/OmniFex.dmg');
  });

  it('waits on the notary verdict rather than firing and forgetting', async () => {
    const d = deps();
    await notarizeDmg('/out/OmniFex.dmg', { keychainProfile: 'omnifex-notary' }, d);

    const [, args] = d.run.mock.calls.find(([, a]) => a.includes('submit'))!;
    expect(args).toContain('--wait');
    expect(args).toContain('--keychain-profile');
    expect(args).toContain('omnifex-notary');
  });

  it('honours an explicit signing identity', async () => {
    const d = deps();
    await notarizeDmg(
      '/out/OmniFex.dmg',
      { keychainProfile: 'omnifex-notary', identity: 'Forced Identity' },
      d,
    );

    const [, args] = d.run.mock.calls.find(([cmd]) => cmd === 'codesign')!;
    expect(args).toContain('Forced Identity');
  });

  // A failed staple must not be swallowed: an unstapled dmg still passes
  // Gatekeeper online and fails offline, which is the worst kind of bug to
  // discover from a user report.
  it('propagates a failure from any step', async () => {
    const d = deps();
    d.run.mockImplementation((cmd: string) => {
      if (cmd === 'security') return SECURITY_OUTPUT;
      if (cmd === 'xcrun') throw new Error('notarization rejected');
      return '';
    });

    await expect(
      notarizeDmg('/out/OmniFex.dmg', { keychainProfile: 'omnifex-notary' }, d),
    ).rejects.toThrow(/notarization rejected/);
  });
});

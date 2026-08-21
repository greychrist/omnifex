/**
 * Sign, notarize, and staple the built `.dmg`.
 *
 * Forge notarizes and staples the `.app` during packaging, then `maker-dmg`
 * wraps that stapled app in a **new disk image that nobody signed**. The app
 * inside is fine once copied out — its ticket travels with it — but the
 * container itself fails Gatekeeper (`spctl` → "no usable signature"), which is
 * what a user actually double-clicks after downloading.
 *
 * This runs as a `postMake` hook, gated on the same `OMNIFEX_NOTARIZE=1` as the
 * app-level notarization, so ordinary local builds don't touch Apple.
 */

/** Injected so the whole flow is testable without shelling out. */
export interface NotarizeDmgDeps {
  /** Run a command to completion; return stdout, throw on non-zero exit. */
  run: (cmd: string, args: string[]) => string;
  log?: (message: string) => void;
}

export interface NotarizeDmgOptions {
  keychainProfile: string;
  /** Overrides certificate discovery. Set via `APPLE_SIGNING_IDENTITY`. */
  identity?: string;
}

/**
 * Extract Developer ID Application certificate names from
 * `security find-identity -v -p codesigning` output.
 *
 * Deliberately narrow: an "Apple Development" cert cannot notarize, and a
 * self-signed one has no Team ID. Matching loosely here would produce a build
 * that signs successfully and is then rejected by the notary service.
 */
export function developerIdIdentities(securityOutput: string): string[] {
  const names: string[] = [];
  for (const line of securityOutput.split('\n')) {
    const match = /"(Developer ID Application: [^"]+)"/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * Choose which certificate to sign with.
 *
 * Refuses to pick between multiple Developer ID certs for the same reason
 * `resolve()` refuses to pick between two accounts that both own a project:
 * silently guessing produces artifacts signed by the wrong team, which is only
 * discovered downstream.
 */
export function pickSigningIdentity(
  available: string[],
  explicit: string | undefined,
): string {
  if (explicit) return explicit;
  if (available.length === 1) return available[0];
  if (available.length === 0) {
    throw new Error(
      'No "Developer ID Application" certificate found in the keychain. ' +
        'Create one in Xcode → Settings → Accounts → Manage Certificates, ' +
        'or set APPLE_SIGNING_IDENTITY.',
    );
  }
  throw new Error(
    `Multiple Developer ID Application certificates found (${available.join(', ')}). ` +
      'Set APPLE_SIGNING_IDENTITY to choose one.',
  );
}

/** Pull every `.dmg` path out of Forge's make results. */
export function dmgArtifacts(
  makeResults: { artifacts?: string[] }[],
): string[] {
  return makeResults
    .flatMap((r) => r.artifacts ?? [])
    .filter((p) => p.toLowerCase().endsWith('.dmg'));
}

export async function notarizeDmg(
  dmgPath: string,
  options: NotarizeDmgOptions,
  deps: NotarizeDmgDeps,
): Promise<void> {
  const { run, log } = deps;

  const identity = pickSigningIdentity(
    developerIdIdentities(run('security', ['find-identity', '-v', '-p', 'codesigning'])),
    options.identity,
  );

  log?.(`[signing] signing ${dmgPath} with "${identity}"`);
  // --timestamp is required for notarization; a signature without a secure
  // timestamp is rejected.
  run('codesign', ['--sign', identity, '--timestamp', '--force', dmgPath]);

  log?.('[signing] submitting dmg to the notary service (this can take a while)');
  run('xcrun', [
    'notarytool',
    'submit',
    dmgPath,
    '--keychain-profile',
    options.keychainProfile,
    '--wait',
  ]);

  // Without the staple the dmg only passes Gatekeeper while online — the
  // failure appears offline, on someone else's machine.
  log?.('[signing] stapling the notary ticket');
  run('xcrun', ['stapler', 'staple', dmgPath]);

  log?.(`[signing] ${dmgPath} signed, notarized, and stapled`);
}

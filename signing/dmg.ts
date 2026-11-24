/**
 * A DMG is a fresh container with no signature of its own: it is signed, notarized and stapled
 * separately, or Gatekeeper rejects the thing a user double-clicks.
 */

export interface NotarizeDmgDeps {
  /** Run a command to completion; return stdout, throw on non-zero exit. */
  run: (cmd: string, args: string[]) => string;
  log?: (message: string) => void;
}

export interface NotarizeDmgOptions {
  keychainProfile: string;
  identity?: string;
}

/** Deliberately narrow: an "Apple Development" cert signs fine and is then rejected by the notary. */
export function developerIdIdentities(securityOutput: string): string[] {
  const names: string[] = [];
  for (const line of securityOutput.split('\n')) {
    const match = /"(Developer ID Application: [^"]+)"/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

/** Never picks between several: a guess signs with the wrong team, found only downstream. */
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
  // The notary rejects a signature without a secure timestamp.
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

  // Unstapled, the dmg passes Gatekeeper only while online.
  log?.('[signing] stapling the notary ticket');
  run('xcrun', ['stapler', 'staple', dmgPath]);

  log?.(`[signing] ${dmgPath} signed, notarized, and stapled`);
}

/** notarytool takes an archive, not a bundle; the ticket is stapled to the bundle itself. */
export async function notarizeApp(
  appPath: string,
  zipPath: string,
  options: Pick<NotarizeDmgOptions, 'keychainProfile'>,
  deps: NotarizeDmgDeps,
): Promise<void> {
  const { run, log } = deps;
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath]);
  log?.('[signing] submitting the app to the notary service (this can take a while)');
  run('xcrun', ['notarytool', 'submit', zipPath, '--keychain-profile', options.keychainProfile, '--wait']);
  log?.('[signing] stapling the notary ticket to the app');
  run('xcrun', ['stapler', 'staple', appPath]);
}

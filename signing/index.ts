import path from 'node:path';

/**
 * macOS Developer ID signing + notarization settings, kept apart from the
 * package script so they can be unit-tested without running a build.
 *
 * Paths are resolved from the working directory (the repo root, for both the
 * package script and vitest).
 */

/** Entitlements for the bundled node, `Contents/MacOS/omnifexd`. */
export const ENTITLEMENTS = path.resolve('signing', 'entitlements.plist');

/** Default `notarytool store-credentials` profile name. */
export const DEFAULT_KEYCHAIN_PROFILE = 'omnifex-notary';

/**
 * Which entitlements a file in the bundle is signed with, or null for none.
 *
 * Only node needs any. Everything is signed with hardened runtime — the
 * notary service rejects an executable without it — and the Swift app needs
 * nothing beyond it: WKWebView's JIT runs in WebKit's own processes.
 */
export function entitlementsFor(filePath: string): string | null {
  return path.basename(filePath) === 'omnifexd' ? ENTITLEMENTS : null;
}

export interface NotarizeConfig {
  keychainProfile: string;
}

/**
 * Notarization is opt-in via `OMNIFEX_NOTARIZE=1`.
 *
 * Without the gate every `npm run package` would upload to Apple and block on
 * the notary queue. The release flow sets it; local builds don't.
 *
 * Credentials come from a `notarytool store-credentials` keychain profile
 * rather than the environment, so the App Store Connect API key never sits in
 * a shell history, a CI variable, or this repo.
 */
export function osxNotarizeConfig(
  env: NodeJS.ProcessEnv = process.env,
): NotarizeConfig | undefined {
  if (env.OMNIFEX_NOTARIZE !== '1') return undefined;

  return {
    keychainProfile: env.APPLE_KEYCHAIN_PROFILE ?? DEFAULT_KEYCHAIN_PROFILE,
  };
}

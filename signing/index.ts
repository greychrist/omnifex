import path from 'node:path';

/**
 * macOS Developer ID signing + notarization config, factored out of
 * forge.config.ts so it can be unit-tested without running a build.
 *
 * Paths are resolved from the working directory, matching the existing
 * cwd-relative convention in forge.config.ts (Forge and vitest both run from
 * the repo root).
 */

export const ENTITLEMENTS = path.resolve('signing', 'entitlements.plist');
export const ENTITLEMENTS_INHERIT = path.resolve('signing', 'entitlements.inherit.plist');

/** Default `notarytool store-credentials` profile name. */
export const DEFAULT_KEYCHAIN_PROFILE = 'omnifex-notary';

export interface FileSigningOptions {
  hardenedRuntime: boolean;
  entitlements: string;
}

/**
 * Per-file signing options handed to @electron/osx-sign.
 *
 * Hardened runtime is mandatory: the notary service rejects any submission
 * containing an executable signed without it.
 */
export function optionsForFile(filePath: string): FileSigningOptions {
  // Renderer / GPU / Plugin helpers are separate bundles with their own
  // signatures. Everything else — the main app, the framework, the .node
  // addons and node-pty's spawn-helper — takes the main entitlements.
  const isHelper = path.basename(filePath).startsWith('OmniFex Helper');

  return {
    hardenedRuntime: true,
    entitlements: isHelper ? ENTITLEMENTS_INHERIT : ENTITLEMENTS,
  };
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

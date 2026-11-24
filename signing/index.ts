import path from 'node:path';

/** Paths resolve from the working directory: the repo root, for the package script and vitest alike. */

/** Entitlements for the bundled node, `Contents/MacOS/omnifexd`. */
export const ENTITLEMENTS = path.resolve('signing', 'entitlements.plist');

export const DEFAULT_KEYCHAIN_PROFILE = 'omnifex-notary';

/**
 * Only node needs entitlements. Everything gets hardened runtime (the notary rejects an executable
 * without it); WKWebView's JIT runs in WebKit's own processes.
 */
export function entitlementsFor(filePath: string): string | null {
  return path.basename(filePath) === 'omnifexd' ? ENTITLEMENTS : null;
}

export interface NotarizeConfig {
  keychainProfile: string;
}

/**
 * Opt-in, or every `npm run package` uploads to Apple. Credentials come from a keychain profile,
 * never the environment, so the API key never sits in shell history or the repo.
 */
export function osxNotarizeConfig(
  env: NodeJS.ProcessEnv = process.env,
): NotarizeConfig | undefined {
  if (env.OMNIFEX_NOTARIZE !== '1') return undefined;

  return {
    keychainProfile: env.APPLE_KEYCHAIN_PROFILE ?? DEFAULT_KEYCHAIN_PROFILE,
  };
}

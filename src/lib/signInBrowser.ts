import { api } from '@/lib/api';
import { platform } from '@/lib/platform';

/**
 * Which browser an account's sign-in links open in.
 *
 * Each account is usually signed in to claude.ai — and to the services its
 * MCP servers use — in one particular browser: Work in Chrome, Personal in
 * Safari. A sign-in link opened in the other one signs in as the wrong
 * identity, or not at all. So the choice is per account, and every sign-in
 * link (Claude's own and MCP servers') goes through `openSignInLink`.
 *
 * Stored in app_settings, keyed by config dir — the one identity every call
 * site has, from the account popover to a session's MCP row. Empty or absent
 * means the system default browser. Only the Mac app can honour it; a web
 * client opens a tab wherever it is.
 */

export function signInBrowserKey(configDir: string): string {
  return `signInBrowser:${configDir}`;
}

/** The chosen browser's bundle id, or null for the default browser. */
export async function getSignInBrowser(configDir: string): Promise<string | null> {
  try {
    const v = await api.getSetting(signInBrowserKey(configDir));
    return v ? v : null;
  } catch {
    return null;
  }
}

/** Choose a browser for this account's sign-in links; null for the default. */
export async function setSignInBrowser(configDir: string, bundleId: string | null): Promise<void> {
  await api.saveSetting(signInBrowserKey(configDir), bundleId ?? '');
}

/** Open a sign-in link in the browser chosen for the account that owns it. */
export async function openSignInLink(url: string, configDir: string | null | undefined): Promise<void> {
  const browser = configDir ? await getSignInBrowser(configDir) : null;
  await platform.openExternal(url, browser ? { browser } : undefined);
}

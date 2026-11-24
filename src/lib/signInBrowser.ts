import { api } from '@/lib/api';
import { platform } from '@/lib/platform';

export function signInBrowserKey(configDir: string): string {
  return `signInBrowser:${configDir}`;
}

export async function getSignInBrowser(configDir: string): Promise<string | null> {
  try {
    const v = await api.getSetting(signInBrowserKey(configDir));
    return v ? v : null;
  } catch {
    return null;
  }
}

export async function setSignInBrowser(configDir: string, bundleId: string | null): Promise<void> {
  await api.saveSetting(signInBrowserKey(configDir), bundleId ?? '');
}

export async function openSignInLink(url: string, configDir: string | null | undefined): Promise<void> {
  const browser = configDir ? await getSignInBrowser(configDir) : null;
  await platform.openExternal(url, browser ? { browser } : undefined);
}

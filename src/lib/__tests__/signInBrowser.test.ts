import { describe, it, expect, vi, beforeEach } from 'vitest';

const api = vi.hoisted(() => ({ getSetting: vi.fn(), saveSetting: vi.fn() }));
const platform = vi.hoisted(() => ({ isDesktop: true, openExternal: vi.fn(async () => {}) }));
vi.mock('@/lib/api', () => ({ api }));
vi.mock('@/lib/platform', () => ({ platform }));

import { signInBrowserKey, getSignInBrowser, setSignInBrowser, openSignInLink } from '@/lib/signInBrowser';

beforeEach(() => {
  api.getSetting.mockReset();
  api.saveSetting.mockReset();
  platform.openExternal.mockClear();
});

describe('signInBrowser', () => {
  it('keys the choice by config dir', () => {
    expect(signInBrowserKey('/Users/me/.claude-work')).toBe('signInBrowser:/Users/me/.claude-work');
  });

  it('reads the stored bundle id, null when unset or the read fails', async () => {
    api.getSetting.mockResolvedValueOnce('com.google.Chrome');
    await expect(getSignInBrowser('/w')).resolves.toBe('com.google.Chrome');
    api.getSetting.mockResolvedValueOnce('');
    await expect(getSignInBrowser('/w')).resolves.toBeNull();
    api.getSetting.mockRejectedValueOnce(new Error('db locked'));
    await expect(getSignInBrowser('/w')).resolves.toBeNull();
  });

  it('stores a choice, and clears it back to the default browser', async () => {
    await setSignInBrowser('/w', 'com.apple.Safari');
    await setSignInBrowser('/w', null);
    expect(api.saveSetting).toHaveBeenNthCalledWith(1, 'signInBrowser:/w', 'com.apple.Safari');
    expect(api.saveSetting).toHaveBeenNthCalledWith(2, 'signInBrowser:/w', '');
  });

  it("opens a sign-in link in the account's browser", async () => {
    api.getSetting.mockResolvedValue('com.google.Chrome');
    await openSignInLink('https://auth', '/w');
    expect(platform.openExternal).toHaveBeenCalledWith('https://auth', { browser: 'com.google.Chrome' });
  });

  it('uses the default browser with no choice or no account', async () => {
    api.getSetting.mockResolvedValue(null);
    await openSignInLink('https://auth', '/w');
    await openSignInLink('https://auth', null);
    expect(platform.openExternal).toHaveBeenNthCalledWith(1, 'https://auth', undefined);
    expect(platform.openExternal).toHaveBeenNthCalledWith(2, 'https://auth', undefined);
  });
});

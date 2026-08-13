// @vitest-environment jsdom
//
// The "View in Log" action on an error toast hands the Settings tab a starting
// panel through sessionStorage. That handoff read the key and DELETED it inside
// a `useState` initializer — a mutation during render, which React StrictMode
// (on in dev) breaks by design: it invokes the initializer twice, so the first
// call consumed the seed and the second returned the default. The button landed
// on Settings/General and looked like it had simply ignored the request.
//
// The event leg could not cover for it either: `Settings` is `React.lazy`, so
// on a freshly created tab the chunk is still loading when the event fires.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SETTINGS_INITIAL_TAB_KEY,
  clearInitialSettingsTab,
  readInitialSettingsTab,
  seedInitialSettingsTab,
} from '@/lib/settingsInitialTab';

describe('settings initial-tab handoff', () => {
  beforeEach(() => { window.sessionStorage.clear(); });

  it('reads the seeded panel', () => {
    seedInitialSettingsTab('log');
    expect(readInitialSettingsTab()).toBe('log');
  });

  it('falls back to general with nothing seeded', () => {
    expect(readInitialSettingsTab()).toBe('general');
  });

  it('survives being read twice, the way StrictMode invokes an initializer', () => {
    // The regression. Reading must be pure: two calls, same answer.
    seedInitialSettingsTab('log');
    expect(readInitialSettingsTab()).toBe('log');
    expect(readInitialSettingsTab()).toBe('log');
  });

  it('clears only when told to, and is safe to clear twice', () => {
    seedInitialSettingsTab('log');
    clearInitialSettingsTab();
    expect(window.sessionStorage.getItem(SETTINGS_INITIAL_TAB_KEY)).toBeNull();
    expect(() => { clearInitialSettingsTab(); }).not.toThrow();
    expect(readInitialSettingsTab()).toBe('general');
  });

  it('treats an unavailable sessionStorage as no seed rather than throwing', () => {
    // Private mode, an opaque origin, a hardened renderer — the handoff is a
    // convenience and must never take the Settings tab down with it.
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new Error('sessionStorage is not available'); },
    });
    try {
      expect(readInitialSettingsTab()).toBe('general');
      expect(() => { clearInitialSettingsTab(); }).not.toThrow();
      expect(() => { seedInitialSettingsTab('log'); }).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });
});

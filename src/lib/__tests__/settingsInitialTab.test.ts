// @vitest-environment jsdom
// Reading must be pure: StrictMode invokes a useState initializer twice.
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

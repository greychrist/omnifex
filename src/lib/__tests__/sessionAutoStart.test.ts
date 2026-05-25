import { describe, it, expect } from 'vitest';
import { decideAutoStart } from '../sessionAutoStart';

describe('decideAutoStart', () => {
  it('skips when the tab is not active (avoid phantom resume on app launch)', () => {
    expect(decideAutoStart({
      isActive: false,
      alreadyStarted: false,
      hasSession: true,
      hasInitialSessionConfig: false,
    })).toBe('skip');
    expect(decideAutoStart({
      isActive: false,
      alreadyStarted: false,
      hasSession: false,
      hasInitialSessionConfig: true,
    })).toBe('skip');
  });

  it('skips when a session has already been started for this tab', () => {
    expect(decideAutoStart({
      isActive: true,
      alreadyStarted: true,
      hasSession: true,
      hasInitialSessionConfig: false,
    })).toBe('skip');
  });

  it('returns rebind-or-resume when active and a saved session is present', () => {
    expect(decideAutoStart({
      isActive: true,
      alreadyStarted: false,
      hasSession: true,
      hasInitialSessionConfig: false,
    })).toBe('rebind-or-resume');
  });

  it('returns fresh-start when active and an inline new-session config is present', () => {
    expect(decideAutoStart({
      isActive: true,
      alreadyStarted: false,
      hasSession: false,
      hasInitialSessionConfig: true,
    })).toBe('fresh-start');
  });

  it('prefers rebind-or-resume over fresh-start when both are present', () => {
    // Defensive: a resumed-session tab should never carry initialSessionConfig,
    // but if it ever did, resuming the prior session wins over a fresh one.
    expect(decideAutoStart({
      isActive: true,
      alreadyStarted: false,
      hasSession: true,
      hasInitialSessionConfig: true,
    })).toBe('rebind-or-resume');
  });

  it('skips when nothing to do', () => {
    expect(decideAutoStart({
      isActive: true,
      alreadyStarted: false,
      hasSession: false,
      hasInitialSessionConfig: false,
    })).toBe('skip');
  });
});

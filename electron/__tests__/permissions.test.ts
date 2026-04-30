import { describe, it, expect } from 'vitest';
import { augmentPermissionsWithSession } from '../services/sessions/permissions';

describe('augmentPermissionsWithSession', () => {
  it('adds a session-destination duplicate for a localSettings allow-rule', () => {
    const input = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Edit', ruleContent: '/.claude/commands/foo.md' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ];
    const out = augmentPermissionsWithSession(input as any) ?? [];
    expect(out).toHaveLength(2);
    expect(out[0].destination).toBe('localSettings');
    expect(out[1].destination).toBe('session');
    expect(out[1].rules).toEqual(input[0].rules);
    expect(out[1].behavior).toBe('allow');
    expect(out[1].type).toBe('addRules');
  });

  it('adds a session duplicate for projectSettings and userSettings entries too', () => {
    const input = [
      { type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'projectSettings' },
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'userSettings' },
    ];
    const out = augmentPermissionsWithSession(input as any) ?? [];
    expect(out).toHaveLength(4);
    expect(out.filter((u: any) => u.destination === 'session')).toHaveLength(2);
  });

  it('does not duplicate entries already targeting the session', () => {
    const input = [
      { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' },
    ];
    const out = augmentPermissionsWithSession(input as any) ?? [];
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(input[0]);
  });

  it('only augments addRules — leaves setMode / addDirectories alone', () => {
    const input = [
      { type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' },
      { type: 'addDirectories', directories: ['/tmp'], destination: 'projectSettings' },
      { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'localSettings' },
    ];
    const out = augmentPermissionsWithSession(input as any) ?? [];
    // Only the addRules entry gets a session duplicate; setMode and addDirectories are passed through unchanged.
    expect(out).toHaveLength(4);
    const addRulesEntries = out.filter((u: any) => u.type === 'addRules');
    expect(addRulesEntries).toHaveLength(2);
    expect(addRulesEntries.find((u: any) => u.destination === 'session')).toBeDefined();
    expect(out.find((u: any) => u.type === 'setMode')).toBeDefined();
    expect(out.find((u: any) => u.type === 'addDirectories')).toBeDefined();
  });

  it('handles deny rules the same way (replaces in session live)', () => {
    const input = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], behavior: 'deny', destination: 'localSettings' },
    ];
    const out = augmentPermissionsWithSession(input as any) ?? [];
    expect(out).toHaveLength(2);
    expect(out[1].destination).toBe('session');
    expect(out[1].behavior).toBe('deny');
  });

  it('returns the input unchanged when undefined or empty', () => {
    expect(augmentPermissionsWithSession(undefined)).toBeUndefined();
    expect(augmentPermissionsWithSession([])).toEqual([]);
  });

  it('does not mutate the input array or its entries', () => {
    const input = [
      { type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'localSettings' },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    augmentPermissionsWithSession(input as any);
    expect(input).toEqual(snapshot);
  });
});

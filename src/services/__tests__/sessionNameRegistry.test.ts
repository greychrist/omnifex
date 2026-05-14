// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionNameRegistry } from '../sessionNameRegistry';

beforeEach(() => {
  localStorage.clear();
  sessionNameRegistry._resetCacheForTests();
});

afterEach(() => {
  localStorage.clear();
  sessionNameRegistry._resetCacheForTests();
});

describe('sessionNameRegistry', () => {
  it('stores and reads back a label', () => {
    sessionNameRegistry.set('tab-1', 'Refactor auth');
    expect(sessionNameRegistry.get('tab-1')).toBe('Refactor auth');
  });

  it('survives a cache reset (round-trips through localStorage)', () => {
    sessionNameRegistry.set('tab-1', 'Fix bug');
    sessionNameRegistry._resetCacheForTests();
    expect(sessionNameRegistry.get('tab-1')).toBe('Fix bug');
  });

  it('returns null for unknown tabIds', () => {
    expect(sessionNameRegistry.get('tab-missing')).toBeNull();
  });

  it('overwrites an existing entry with a newer title', () => {
    sessionNameRegistry.set('tab-1', 'Old');
    sessionNameRegistry.set('tab-1', 'New');
    expect(sessionNameRegistry.get('tab-1')).toBe('New');
  });

  it('ignores empty / whitespace titles so default placeholders never poison the map', () => {
    sessionNameRegistry.set('tab-1', '');
    sessionNameRegistry.set('tab-1', '   ');
    expect(sessionNameRegistry.get('tab-1')).toBeNull();
  });

  it('ignores empty tabIds', () => {
    sessionNameRegistry.set('', 'whatever');
    expect(sessionNameRegistry.snapshot()).toEqual({});
  });

  it('snapshot returns a plain title map', () => {
    sessionNameRegistry.set('tab-a', 'A');
    sessionNameRegistry.set('tab-b', 'B');
    expect(sessionNameRegistry.snapshot()).toEqual({
      'tab-a': 'A',
      'tab-b': 'B',
    });
  });

  it('tolerates malformed localStorage payloads', () => {
    localStorage.setItem('omnifex_session_name_registry_v1', 'not json');
    sessionNameRegistry._resetCacheForTests();
    expect(sessionNameRegistry.get('tab-1')).toBeNull();
    sessionNameRegistry.set('tab-1', 'Recovered');
    expect(sessionNameRegistry.get('tab-1')).toBe('Recovered');
  });
});

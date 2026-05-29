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
  it('stores and reads back a title-only entry', () => {
    sessionNameRegistry.set('tab-1', { title: 'Refactor auth' });
    const entry = sessionNameRegistry.get('tab-1');
    expect(entry?.title).toBe('Refactor auth');
    expect(entry?.projectName).toBeUndefined();
    expect(entry?.claudeSessionId).toBeUndefined();
  });

  it('stores all three identity fields together', () => {
    sessionNameRegistry.set('tab-1', {
      title: 'Bug hunt',
      projectName: 'omnifex',
      claudeSessionId: '51b1aff1-3c40-46ce-9c7b-b2d274c7e8ab',
    });
    const entry = sessionNameRegistry.get('tab-1');
    expect(entry).toMatchObject({
      title: 'Bug hunt',
      projectName: 'omnifex',
      claudeSessionId: '51b1aff1-3c40-46ce-9c7b-b2d274c7e8ab',
    });
  });

  it('merges partial updates instead of overwriting', () => {
    // Common lifecycle: tab opens with title + projectName, then the CLI
    // assigns a claudeSessionId a moment later. The second write must not
    // erase what the first one stored.
    sessionNameRegistry.set('tab-1', {
      title: 'Bug hunt',
      projectName: 'omnifex',
    });
    sessionNameRegistry.set('tab-1', {
      claudeSessionId: '51b1aff1-3c40-46ce-9c7b-b2d274c7e8ab',
    });
    const entry = sessionNameRegistry.get('tab-1');
    expect(entry?.title).toBe('Bug hunt');
    expect(entry?.projectName).toBe('omnifex');
    expect(entry?.claudeSessionId).toBe('51b1aff1-3c40-46ce-9c7b-b2d274c7e8ab');
  });

  it('survives a cache reset (round-trips through localStorage)', () => {
    sessionNameRegistry.set('tab-1', { title: 'Fix bug', projectName: 'omnifex' });
    sessionNameRegistry._resetCacheForTests();
    const entry = sessionNameRegistry.get('tab-1');
    expect(entry?.title).toBe('Fix bug');
    expect(entry?.projectName).toBe('omnifex');
  });

  it('returns null for unknown tabIds', () => {
    expect(sessionNameRegistry.get('tab-missing')).toBeNull();
  });

  it('ignores empty / whitespace fields so default placeholders never poison the map', () => {
    sessionNameRegistry.set('tab-1', { title: '   ', projectName: '' });
    expect(sessionNameRegistry.get('tab-1')).toBeNull();
  });

  it('ignores empty tabIds', () => {
    sessionNameRegistry.set('', { title: 'whatever' });
    expect(sessionNameRegistry.snapshot()).toEqual({});
  });

  it('snapshot returns shallow copies (callers cannot mutate the cache)', () => {
    sessionNameRegistry.set('tab-a', { title: 'A' });
    const snap = sessionNameRegistry.snapshot();
    snap['tab-a'].title = 'mutated';
    expect(sessionNameRegistry.get('tab-a')?.title).toBe('A');
  });

  it('reads back legacy v1 entries that only had {title, updatedAt}', () => {
    // Older builds wrote entries with just `{ title, updatedAt }`. Make sure
    // those round-trip cleanly: the new schema's extra fields are simply
    // absent (undefined), which is exactly what the Log tab's fallback
    // chain expects.
    const legacy = {
      'tab-legacy': { title: 'Pre-upgrade session', updatedAt: 1700000000000 },
    };
    localStorage.setItem('omnifex_session_name_registry_v1', JSON.stringify(legacy));
    sessionNameRegistry._resetCacheForTests();

    const entry = sessionNameRegistry.get('tab-legacy');
    expect(entry?.title).toBe('Pre-upgrade session');
    expect(entry?.projectName).toBeUndefined();
    expect(entry?.claudeSessionId).toBeUndefined();
  });

  it('tolerates malformed localStorage payloads', () => {
    localStorage.setItem('omnifex_session_name_registry_v1', 'not json');
    sessionNameRegistry._resetCacheForTests();
    expect(sessionNameRegistry.get('tab-1')).toBeNull();
    sessionNameRegistry.set('tab-1', { title: 'Recovered' });
    expect(sessionNameRegistry.get('tab-1')?.title).toBe('Recovered');
  });
});

import { describe, it, expect } from 'vitest';
import {
  claimCliUpdateNotice,
  CLI_NOTIFIED_VERSION_SETTING_KEY,
} from '../services/cli-update-notice';

function store(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getSetting: (k: string) => data.get(k) ?? null,
    saveSetting: (k: string, v: string) => { data.set(k, v); },
  };
}

describe('claimCliUpdateNotice', () => {
  it('claims a version exactly once', () => {
    const s = store();
    expect(claimCliUpdateNotice(s, '2.1.323')).toBe(true);
    expect(s.data.get(CLI_NOTIFIED_VERSION_SETTING_KEY)).toBe('2.1.323');
    expect(claimCliUpdateNotice(s, '2.1.323')).toBe(false);
  });

  it('never claims an older version than the last one notified', () => {
    const s = store({ [CLI_NOTIFIED_VERSION_SETTING_KEY]: '2.1.323' });
    expect(claimCliUpdateNotice(s, '2.1.322')).toBe(false);
    expect(s.data.get(CLI_NOTIFIED_VERSION_SETTING_KEY)).toBe('2.1.323');
  });

  it('claims a newer version', () => {
    const s = store({ [CLI_NOTIFIED_VERSION_SETTING_KEY]: '2.1.323' });
    expect(claimCliUpdateNotice(s, '2.1.324')).toBe(true);
    expect(s.data.get(CLI_NOTIFIED_VERSION_SETTING_KEY)).toBe('2.1.324');
  });

  it('refuses an unparseable version and stores nothing', () => {
    const s = store();
    expect(claimCliUpdateNotice(s, 'garbage')).toBe(false);
    expect(claimCliUpdateNotice(s, '')).toBe(false);
    expect(s.data.has(CLI_NOTIFIED_VERSION_SETTING_KEY)).toBe(false);
  });

  it('treats a garbage stored value as never notified', () => {
    const s = store({ [CLI_NOTIFIED_VERSION_SETTING_KEY]: 'nope' });
    expect(claimCliUpdateNotice(s, '2.1.323')).toBe(true);
  });
});

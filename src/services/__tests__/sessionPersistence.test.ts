// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionPersistenceService, type SessionRestoreData } from '../sessionPersistence';

const STORAGE_KEY_PREFIX = 'greychrist_session_';
const SESSION_INDEX_KEY = 'greychrist_session_index';

// api is referenced only by isSessionRestorable; mock it so the rest of
// the suite runs without the IPC surface.
vi.mock('@/lib/api', () => ({
  api: { loadSessionHistory: vi.fn() },
}));

import { api } from '@/lib/api';

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('SessionPersistenceService — saveSession + loadSession', () => {
  it('writes session data under the prefix key and adds the id to the index', () => {
    SessionPersistenceService.saveSession('s1', 'p1', '/repos/x', 7, 250);
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}s1`);
    expect(raw).not.toBeNull();
    const data = JSON.parse(raw!) as SessionRestoreData;
    expect(data.sessionId).toBe('s1');
    expect(data.projectId).toBe('p1');
    expect(data.projectPath).toBe('/repos/x');
    expect(data.lastMessageCount).toBe(7);
    expect(data.scrollPosition).toBe(250);
    expect(typeof data.timestamp).toBe('number');

    const index = JSON.parse(localStorage.getItem(SESSION_INDEX_KEY)!) as string[];
    expect(index).toEqual(['s1']);
  });

  it('does not add duplicate ids to the index on re-save', () => {
    SessionPersistenceService.saveSession('s1', 'p1', '/x');
    SessionPersistenceService.saveSession('s1', 'p1', '/x');
    const index = JSON.parse(localStorage.getItem(SESSION_INDEX_KEY)!) as string[];
    expect(index).toEqual(['s1']);
  });

  it('loadSession returns null when no key exists', () => {
    expect(SessionPersistenceService.loadSession('missing')).toBeNull();
  });

  it('loadSession returns null on malformed JSON (caught) and logs once', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(`${STORAGE_KEY_PREFIX}bad`, '{not valid json');
    expect(SessionPersistenceService.loadSession('bad')).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('loadSession returns null when stored data is missing required fields', () => {
    localStorage.setItem(`${STORAGE_KEY_PREFIX}partial`, JSON.stringify({ sessionId: 's' }));
    expect(SessionPersistenceService.loadSession('partial')).toBeNull();
  });
});

describe('SessionPersistenceService — removeSession / clearAllSessions', () => {
  it('removeSession drops the data and removes the id from the index', () => {
    SessionPersistenceService.saveSession('s1', 'p1', '/x');
    SessionPersistenceService.saveSession('s2', 'p1', '/x');
    SessionPersistenceService.removeSession('s1');
    expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}s1`)).toBeNull();
    expect(JSON.parse(localStorage.getItem(SESSION_INDEX_KEY)!)).toEqual(['s2']);
  });

  it('clearAllSessions wipes every indexed session entry and the index itself', () => {
    SessionPersistenceService.saveSession('s1', 'p1', '/x');
    SessionPersistenceService.saveSession('s2', 'p1', '/x');
    SessionPersistenceService.clearAllSessions();
    expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}s1`)).toBeNull();
    expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}s2`)).toBeNull();
    expect(localStorage.getItem(SESSION_INDEX_KEY)).toBeNull();
  });

  it('getSessionIndex returns [] when key is missing', () => {
    expect(SessionPersistenceService.getSessionIndex()).toEqual([]);
  });

  it('getSessionIndex returns [] on corrupted JSON', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem(SESSION_INDEX_KEY, 'not json');
    expect(SessionPersistenceService.getSessionIndex()).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('SessionPersistenceService — cleanupOldSessions', () => {
  it('drops entries older than 30 days and keeps the rest', () => {
    vi.useFakeTimers();
    const now = new Date('2026-06-15T00:00:00Z').getTime();
    vi.setSystemTime(now);

    // Write a fresh one (now) and a stale one (40 days ago) by hand to
    // dodge saveSession's `timestamp: Date.now()` write.
    const fresh: SessionRestoreData = { sessionId: 'fresh', projectId: 'p', projectPath: '/x', timestamp: now };
    const stale: SessionRestoreData = { sessionId: 'stale', projectId: 'p', projectPath: '/x', timestamp: now - 40 * 24 * 60 * 60 * 1000 };
    localStorage.setItem(`${STORAGE_KEY_PREFIX}fresh`, JSON.stringify(fresh));
    localStorage.setItem(`${STORAGE_KEY_PREFIX}stale`, JSON.stringify(stale));
    localStorage.setItem(SESSION_INDEX_KEY, JSON.stringify(['fresh', 'stale']));

    SessionPersistenceService.cleanupOldSessions();

    expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}fresh`)).not.toBeNull();
    expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}stale`)).toBeNull();
    expect(JSON.parse(localStorage.getItem(SESSION_INDEX_KEY)!)).toEqual(['fresh']);

    vi.useRealTimers();
  });
});

describe('SessionPersistenceService — isSessionRestorable', () => {
  it('returns false when no metadata is saved', async () => {
    expect(await SessionPersistenceService.isSessionRestorable('s', 'p', '/x')).toBe(false);
  });

  it('returns false when the saved session has no history on disk', async () => {
    SessionPersistenceService.saveSession('s1', 'p1', '/x');
    (api.loadSessionHistory as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    expect(await SessionPersistenceService.isSessionRestorable('s1', 'p1', '/x')).toBe(false);
  });

  it('returns true when history loads with at least one entry', async () => {
    SessionPersistenceService.saveSession('s1', 'p1', '/x');
    (api.loadSessionHistory as ReturnType<typeof vi.fn>).mockResolvedValue([{ type: 'user' }]);
    expect(await SessionPersistenceService.isSessionRestorable('s1', 'p1', '/x')).toBe(true);
  });

  it('returns false (and logs) when the history call rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    SessionPersistenceService.saveSession('s1', 'p1', '/x');
    (api.loadSessionHistory as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk fail'));
    expect(await SessionPersistenceService.isSessionRestorable('s1', 'p1', '/x')).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('SessionPersistenceService — createSessionFromRestoreData', () => {
  it('maps fields and divides the stored ms timestamp into seconds', () => {
    const data: SessionRestoreData = {
      sessionId: 's', projectId: 'p', projectPath: '/x', timestamp: 2_000_000_000_000,
    };
    const session = SessionPersistenceService.createSessionFromRestoreData(data);
    expect(session.id).toBe('s');
    expect(session.project_id).toBe('p');
    expect(session.project_path).toBe('/x');
    expect(session.created_at).toBe(2_000_000_000);
    expect(session.first_message).toBe('Restored session');
  });
});

describe('SessionPersistenceService — migrateFromOldKeys', () => {
  it('moves the opcode_session_index value into the new key', () => {
    localStorage.setItem('opcode_session_index', JSON.stringify(['s1']));
    SessionPersistenceService.migrateFromOldKeys();
    expect(localStorage.getItem(SESSION_INDEX_KEY)).toBe(JSON.stringify(['s1']));
    expect(localStorage.getItem('opcode_session_index')).toBeNull();
  });

  it('renames each opcode_session_<id> entry to greychrist_session_<id>', () => {
    localStorage.setItem('opcode_session_abc', '{"sessionId":"abc"}');
    SessionPersistenceService.migrateFromOldKeys();
    expect(localStorage.getItem(`${STORAGE_KEY_PREFIX}abc`)).toBe('{"sessionId":"abc"}');
    expect(localStorage.getItem('opcode_session_abc')).toBeNull();
  });

  it('does not overwrite already-migrated keys', () => {
    localStorage.setItem('opcode_session_index', JSON.stringify(['old']));
    localStorage.setItem(SESSION_INDEX_KEY, JSON.stringify(['new']));
    SessionPersistenceService.migrateFromOldKeys();
    expect(JSON.parse(localStorage.getItem(SESSION_INDEX_KEY)!)).toEqual(['new']);
  });
});

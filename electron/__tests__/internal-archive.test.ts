import { describe, it, expect } from 'vitest';
import {
  internalArchiveRoot,
  archiveDirFor,
  INTERNAL_LABEL,
  INTERNAL_KINDS,
  archiveTranscripts,
} from '../services/sessions/internal-archive';

describe('internal archive paths', () => {
  it('roots under userData, partitioned by account, kind and date', () => {
    const root = internalArchiveRoot('/u');
    expect(root).toBe('/u/internal-sessions');
    expect(archiveDirFor(root, 'Work', 'brain-index', '2026-08-26')).toBe(
      '/u/internal-sessions/Work/brain-index/2026-08-26',
    );
  });

  it('labels every kind for the cost report', () => {
    expect(INTERNAL_LABEL['session-summarization']).toBe('OmniFex/Session summarization');
    expect(INTERNAL_LABEL['brain-index']).toBe('OmniFex/Brain index');
    expect(INTERNAL_LABEL['brain-curation']).toBe('OmniFex/Brain curation');
  });

  // Every kind must have a label, or a row lands in the cost table with an
  // undefined project_path and silently disappears from the by-project table.
  it('labels are total over the kind list', () => {
    for (const k of INTERNAL_KINDS) {
      expect(typeof INTERNAL_LABEL[k]).toBe('string');
      expect(INTERNAL_LABEL[k].startsWith('OmniFex/')).toBe(true);
    }
  });

  // Account names are user-supplied and reach the filesystem here. An account
  // called '../..' must not be able to point the archive at someone's home dir.
  it('sanitises an account name into a single safe segment', () => {
    const d = archiveDirFor('/u/internal-sessions', '../evil', 'brain-index', '2026-08-26');
    expect(d.startsWith('/u/internal-sessions/')).toBe(true);
    expect(d).not.toContain('..');
  });

  it('keeps a separator out of the segment', () => {
    const d = archiveDirFor('/u/internal-sessions', 'Work/Personal', 'brain-index', '2026-08-26');
    expect(d).toBe('/u/internal-sessions/Work_Personal/brain-index/2026-08-26');
  });

  it('never produces an empty segment', () => {
    expect(archiveDirFor('/u/r', '', 'brain-index', '2026-08-26')).toBe(
      '/u/r/_/brain-index/2026-08-26',
    );
  });
});

// ── The move ───────────────────────────────────────────────────────────────
//
// The old behaviour deleted these files. The new behaviour moves them, and
// the failure mode that matters is a move that half-happens: losing the only
// copy of a transcript loses the record of money already spent.

interface FakeFsOpts { failRename?: boolean; failCopy?: boolean }

function fakeFs(files: Record<string, string>, opts: FakeFsOpts = {}) {
  const store = new Map(Object.entries(files));
  const dirs = new Set<string>();
  return {
    store,
    exists: (p: string) => store.has(p),
    async mkdir(p: string) { dirs.add(p); },
    async readdir(p: string) {
      const prefix = p.endsWith('/') ? p : `${p}/`;
      const names = [...store.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map((k) => k.slice(prefix.length));
      if (names.length === 0 && !dirs.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return names;
    },
    async rename(from: string, to: string) {
      if (opts.failRename) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      store.set(to, store.get(from)!);
      store.delete(from);
    },
    async copyFile(from: string, to: string) {
      if (opts.failCopy) throw new Error('EIO');
      store.set(to, store.get(from)!);
    },
    async unlink(p: string) { store.delete(p); },
    async stat(p: string) {
      if (!store.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { size: store.get(p)!.length };
    },
  };
}

describe('archiveTranscripts', () => {
  it('moves each transcript and reports what moved', async () => {
    const fs = fakeFs({ '/p/a.jsonl': 'x', '/p/b.jsonl': 'y' });
    const r = await archiveTranscripts({ fs, projectsDir: '/p', destDir: '/d' });
    expect(r.moved.sort()).toEqual(['/d/a.jsonl', '/d/b.jsonl']);
    expect(r.failed).toEqual([]);
    expect(fs.exists('/p/a.jsonl')).toBe(false);
    expect(fs.exists('/d/a.jsonl')).toBe(true);
  });

  it('ignores anything that is not a transcript', async () => {
    const fs = fakeFs({ '/p/a.jsonl': 'x', '/p/notes.txt': 'y' });
    const r = await archiveTranscripts({ fs, projectsDir: '/p', destDir: '/d' });
    expect(r.moved).toEqual(['/d/a.jsonl']);
    expect(fs.exists('/p/notes.txt')).toBe(true);
  });

  // A cross-device rename is the ordinary case when userData and tmp live on
  // different volumes, so it must degrade to copy+unlink rather than fail.
  it('falls back to copy and unlink when rename cannot cross devices', async () => {
    const fs = fakeFs({ '/p/a.jsonl': 'x' }, { failRename: true });
    const r = await archiveTranscripts({ fs, projectsDir: '/p', destDir: '/d' });
    expect(r.moved).toEqual(['/d/a.jsonl']);
    expect(fs.exists('/p/a.jsonl')).toBe(false);
    expect(fs.exists('/d/a.jsonl')).toBe(true);
  });

  // THE test. If both paths fail, the source stays put and we say so. The
  // alternative -- unlinking anyway -- destroys the only record of a paid call.
  it('leaves the source in place when the move fails outright', async () => {
    const fs = fakeFs({ '/p/a.jsonl': 'x' }, { failRename: true, failCopy: true });
    const r = await archiveTranscripts({ fs, projectsDir: '/p', destDir: '/d' });
    expect(r.failed).toEqual(['/p/a.jsonl']);
    expect(r.moved).toEqual([]);
    expect(fs.exists('/p/a.jsonl')).toBe(true);
  });

  it('treats a missing projects dir as nothing to do', async () => {
    const r = await archiveTranscripts({ fs: fakeFs({}), projectsDir: '/nope', destDir: '/d' });
    expect(r).toEqual({ moved: [], failed: [] });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyInternalPrompt,
  isSummaryScratchProject,
  settleStrandedScratch,
  settleTranscripts,
  type RecordInternalSpend,
} from '../services/sessions/internal-spend';

// OmniFex's own `claude -p` runs are never kept. Each transcript is priced
// into the cost table and deleted; the spend is the only record. A transcript
// that cannot be priced stays where it is — deleting it would lose the spend —
// and the next sweep retries.

const SCRATCH = '-private-var-folders-06-x-T-omnifex-summary-scratch';
const HOUR = 3_600_000;

function userLine(prompt: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n';
}

describe('isSummaryScratchProject', () => {
  it('matches the encoded scratch cwd and nothing else', () => {
    expect(isSummaryScratchProject(SCRATCH)).toBe(true);
    expect(isSummaryScratchProject('-Users-me-repo')).toBe(false);
  });
});

describe('classifyInternalPrompt', () => {
  it('names Brain curation by its compression preamble', () => {
    expect(classifyInternalPrompt('You are compressing one note in an engineering knowledge vault'))
      .toBe('brain-curation');
    expect(classifyInternalPrompt('You are compressing the history section of one note'))
      .toBe('brain-curation');
  });

  it('names Brain indexing by its extraction and capture preambles', () => {
    expect(classifyInternalPrompt('You are extracting durable engineering knowledge from one coding session.'))
      .toBe('brain-index');
    expect(classifyInternalPrompt('You are turning one fact a developer explicitly captured into durable vault entities.'))
      .toBe('brain-index');
  });

  // The summary prompt is the one users can edit, so it is the only kind
  // whose wording cannot be pinned — anything unrecognised is a summary.
  it('treats anything else as a session summary', () => {
    expect(classifyInternalPrompt('You are summarizing a coding-assistant session')).toBe('session-summarization');
    expect(classifyInternalPrompt('My own custom summary prompt')).toBe('session-summarization');
    expect(classifyInternalPrompt(null)).toBe('session-summarization');
  });
});

describe('settling internal transcripts', () => {
  let root: string;
  let configDir: string;
  let scratchDir: string;
  let record: ReturnType<typeof vi.fn<RecordInternalSpend>>;
  const now = Date.parse('2026-10-09T18:00:00Z');

  function transcript(name: string, prompt: string, mtimeMs: number, dir = scratchDir): string {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify({ type: 'queue-operation' }) + '\n' + userLine(prompt));
    fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    return p;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-settle-'));
    configDir = path.join(root, 'config');
    scratchDir = path.join(configDir, 'projects', SCRATCH);
    record = vi.fn<RecordInternalSpend>();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('settleTranscripts (the runner, as its call returns)', () => {
    it('records the spend under the given kind, then deletes the transcript and its dir', () => {
      transcript('abc.jsonl', 'anything', now);
      fs.mkdirSync(path.join(scratchDir, 'memory'));

      const r = settleTranscripts({
        projectsDir: scratchDir, kind: 'brain-curation', accountName: 'Work', configDir, record,
      });

      expect(record).toHaveBeenCalledWith({
        sessionId: 'abc', content: expect.stringContaining('anything'),
        kind: 'brain-curation', accountName: 'Work', configDir,
      });
      expect(r).toEqual({ settled: 1, failed: 0 });
      expect(fs.existsSync(scratchDir)).toBe(false);
    });

    it('keeps a transcript whose spend could not be recorded', () => {
      const p = transcript('abc.jsonl', 'anything', now);
      record.mockImplementation(() => { throw new Error('db locked'); });

      const r = settleTranscripts({
        projectsDir: scratchDir, kind: 'brain-index', accountName: 'Work', configDir, record,
      });

      expect(r).toEqual({ settled: 0, failed: 1 });
      expect(fs.existsSync(p)).toBe(true);
    });

    it('is a no-op when the CLI wrote nothing', () => {
      expect(settleTranscripts({
        projectsDir: scratchDir, kind: 'brain-index', accountName: 'Work', configDir, record,
      })).toEqual({ settled: 0, failed: 0 });
    });
  });

  describe('settleStrandedScratch (the hourly backstop)', () => {
    const accounts = () => [{ name: 'Work', config_dir: configDir }];

    it('classifies each stray by its prompt, records it, and leaves nothing behind', () => {
      transcript('a.jsonl', 'You are extracting durable engineering knowledge', now - 2 * HOUR);
      transcript('b.jsonl', 'You are compressing one note', now - 2 * HOUR);
      fs.mkdirSync(path.join(scratchDir, 'memory'));
      fs.writeFileSync(path.join(scratchDir, 'memory', 'MEMORY.md'), 'x');

      const r = settleStrandedScratch({ accounts: accounts(), record, nowMs: now });

      expect(r).toEqual({ settled: 2, failed: 0 });
      expect(record.mock.calls.map(([c]) => [c.sessionId, c.kind]).sort()).toEqual([
        ['a', 'brain-index'], ['b', 'brain-curation'],
      ]);
      expect(fs.existsSync(scratchDir)).toBe(false);
    });

    // A Brain extraction prompt embeds the whole session it distils, so its
    // first user record can run to megabytes — far past any head read. It
    // must still be named by its preamble, not fall through to "summary".
    it('classifies a prompt record far larger than the head it reads', () => {
      transcript('big.jsonl', `You are extracting durable engineering knowledge ${'x'.repeat(500_000)}`, now - 2 * HOUR);

      settleStrandedScratch({ accounts: accounts(), record, nowMs: now });

      expect(record).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'big', kind: 'brain-index' }));
    });

    // A run in flight is still writing its transcript, and its own runner will
    // settle it within seconds.
    it('leaves a recent transcript, and its dir, for the run still writing it', () => {
      const fresh = transcript('fresh.jsonl', 'summary', now - 60_000);

      const r = settleStrandedScratch({ accounts: accounts(), record, nowMs: now });

      expect(r).toEqual({ settled: 0, failed: 0 });
      expect(record).not.toHaveBeenCalled();
      expect(fs.existsSync(fresh)).toBe(true);
    });

    it('never touches a real project dir', () => {
      const real = transcript('u.jsonl', 'summary', now - 2 * HOUR, path.join(configDir, 'projects', '-Users-me-repo'));

      settleStrandedScratch({ accounts: accounts(), record, nowMs: now });

      expect(record).not.toHaveBeenCalled();
      expect(fs.existsSync(real)).toBe(true);
    });

    it('is a no-op for an account with no projects dir', () => {
      expect(settleStrandedScratch({
        accounts: [{ name: 'Empty', config_dir: path.join(root, 'nope') }], record, nowMs: now,
      })).toEqual({ settled: 0, failed: 0 });
    });
  });
});

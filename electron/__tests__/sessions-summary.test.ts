import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readSidecar,
  writeSidecar,
  sidecarPathFor,
  extractTranscript,
  type SessionSummary,
} from '../services/sessions-summary';

describe('sessions-summary sidecar I/O', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-summary-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('readSidecar returns null when the sidecar file does not exist', () => {
    const result = readSidecar(path.join(tmpDir, 'nonexistent.summary.json'));
    expect(result).toBeNull();
  });

  it('readSidecar returns null when the file is not valid JSON', () => {
    const p = path.join(tmpDir, 'broken.summary.json');
    fs.writeFileSync(p, 'this is not json {{{', 'utf-8');
    expect(readSidecar(p)).toBeNull();
  });

  it('readSidecar returns null when the schema version does not match', () => {
    const p = path.join(tmpDir, 'old.summary.json');
    fs.writeFileSync(
      p,
      JSON.stringify({ version: 99, headline: 'x', paragraph: 'y' }),
      'utf-8',
    );
    expect(readSidecar(p)).toBeNull();
  });

  it('writeSidecar + readSidecar round-trips a valid summary', () => {
    const p = path.join(tmpDir, 'ok.summary.json');
    const summary: SessionSummary = {
      version: 1,
      headline: 'Test headline',
      paragraph: 'Test paragraph.',
      messageCount: 12,
      jsonlSize: 4096,
      generatedAt: '2026-05-05T16:00:00.000Z',
      model: 'claude-haiku-4-5',
      accountName: 'Test Account',
    };
    writeSidecar(p, summary);
    expect(readSidecar(p)).toEqual(summary);
  });

  it('writeSidecar is atomic — never leaves the final file in a partial state', () => {
    const p = path.join(tmpDir, 'atomic.summary.json');
    const summary: SessionSummary = {
      version: 1,
      headline: 'h',
      paragraph: 'p',
      messageCount: 1,
      jsonlSize: 1,
      generatedAt: '2026-05-05T16:00:00.000Z',
      model: 'claude-haiku-4-5',
      accountName: 'A',
    };
    writeSidecar(p, summary);
    expect(fs.existsSync(p + '.tmp')).toBe(false);
    expect(() => JSON.parse(fs.readFileSync(p, 'utf-8'))).not.toThrow();
  });

  it('sidecarPathFor swaps .jsonl for .summary.json', () => {
    expect(sidecarPathFor('/x/y/abc.jsonl')).toBe('/x/y/abc.summary.json');
  });
});

describe('sessions-summary transcript extraction', () => {
  it('extracts user and assistant text in order with messageCount', () => {
    const jsonl = [
      JSON.stringify({
        type: 'user',
        message: { content: 'Help me debug this.' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Sure — show me the error.' }],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: 'TypeError: undefined is not a function' },
      }),
    ].join('\n');

    const result = extractTranscript(jsonl);

    expect(result.messageCount).toBe(3);
    expect(result.transcript).toBe(
      [
        'USER: Help me debug this.',
        'ASSISTANT: Sure — show me the error.',
        'USER: TypeError: undefined is not a function',
      ].join('\n'),
    );
  });

  it('drops assistant tool_use blocks and keeps only text blocks', () => {
    const jsonl = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading the file.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/x' } },
          { type: 'text', text: 'Done.' },
        ],
      },
    });
    const result = extractTranscript(jsonl);
    expect(result.transcript).toBe('ASSISTANT: Reading the file.\nDone.');
    expect(result.messageCount).toBe(1);
  });

  it('drops user tool_result rows (no plain text part)', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'file contents' },
        ],
      },
    });
    expect(extractTranscript(jsonl)).toEqual({ transcript: '', messageCount: 0 });
  });

  it('drops isMeta entries', () => {
    const jsonl = JSON.stringify({
      type: 'user',
      isMeta: true,
      message: { content: 'session-start meta noise' },
    });
    expect(extractTranscript(jsonl)).toEqual({ transcript: '', messageCount: 0 });
  });

  it('drops <command-name> / <command-stdout> wrapper rows', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { content: '<command-name>verify</command-name>' } }),
      JSON.stringify({ type: 'user', message: { content: '<command-stdout>OK</command-stdout>' } }),
      JSON.stringify({ type: 'user', message: { content: 'real user message' } }),
    ].join('\n');
    const result = extractTranscript(jsonl);
    expect(result.transcript).toBe('USER: real user message');
    expect(result.messageCount).toBe(1);
  });

  it('drops type === "summary" SDK auto-compaction entries', () => {
    const jsonl = JSON.stringify({ type: 'summary', summary: 'old context', leafUuid: 'x' });
    expect(extractTranscript(jsonl)).toEqual({ transcript: '', messageCount: 0 });
  });

  it('skips malformed JSON lines without crashing', () => {
    const jsonl = [
      '{not json',
      JSON.stringify({ type: 'user', message: { content: 'good message' } }),
      '',
      '   ',
    ].join('\n');
    const result = extractTranscript(jsonl);
    expect(result.transcript).toBe('USER: good message');
    expect(result.messageCount).toBe(1);
  });
});

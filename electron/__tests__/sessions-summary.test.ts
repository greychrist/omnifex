import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readSidecar,
  writeSidecar,
  sidecarPathFor,
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

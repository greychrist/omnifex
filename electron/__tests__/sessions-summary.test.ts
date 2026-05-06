import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readSidecar,
  writeSidecar,
  sidecarPathFor,
  extractTranscript,
  truncateForModel,
  parseSummaryXML,
  createSessionsSummaryService,
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

describe('sessions-summary truncation', () => {
  it('returns the transcript unchanged when under the cap', () => {
    const small = 'USER: hi\nASSISTANT: hello\n';
    expect(truncateForModel(small)).toEqual({
      transcript: small,
      truncated: false,
    });
  });

  it('truncates by keeping first 240K chars + elision marker + last 240K chars', () => {
    const huge = 'A'.repeat(800_000);
    const result = truncateForModel(huge);
    expect(result.truncated).toBe(true);
    expect(result.transcript.startsWith('A'.repeat(240_000))).toBe(true);
    expect(result.transcript.endsWith('A'.repeat(240_000))).toBe(true);
    expect(result.transcript).toContain('tokens elided');
    expect(result.transcript.length).toBeLessThan(huge.length);
  });

  it('threshold is 720K characters (≈180K tokens)', () => {
    const justUnder = 'B'.repeat(720_000);
    expect(truncateForModel(justUnder).truncated).toBe(false);

    const justOver = 'B'.repeat(720_001);
    expect(truncateForModel(justOver).truncated).toBe(true);
  });
});

describe('sessions-summary XML parsing', () => {
  it('extracts both fields from a well-formed response', () => {
    const response =
      '<headline>Migrated SessionList to a paginated table.</headline>\n' +
      '<paragraph>Started by virtualizing, then pivoted to pagination. Left the optimized variant for deletion.</paragraph>';
    expect(parseSummaryXML(response)).toEqual({
      headline: 'Migrated SessionList to a paginated table.',
      paragraph:
        'Started by virtualizing, then pivoted to pagination. Left the optimized variant for deletion.',
    });
  });

  it('tolerates prose around the tags', () => {
    const response =
      'Sure! Here is your summary:\n\n' +
      '<headline>Refactored the auth flow.</headline>\n' +
      '<paragraph>Removed the legacy callback. Added refresh-token support. Tests green.</paragraph>\n\n' +
      'Hope that helps!';
    const parsed = parseSummaryXML(response);
    expect(parsed?.headline).toBe('Refactored the auth flow.');
    expect(parsed?.paragraph).toBe(
      'Removed the legacy callback. Added refresh-token support. Tests green.',
    );
  });

  it('returns null when <headline> is missing', () => {
    expect(parseSummaryXML('<paragraph>Only paragraph.</paragraph>')).toBeNull();
  });

  it('returns null when <paragraph> is missing', () => {
    expect(parseSummaryXML('<headline>Only headline.</headline>')).toBeNull();
  });

  it('returns null when both tags are missing', () => {
    expect(parseSummaryXML('Just plain prose, no tags.')).toBeNull();
  });

  it('trims surrounding whitespace inside the tags', () => {
    const response =
      '<headline>\n  Trimmed headline.\n</headline>\n' +
      '<paragraph>\n  Trimmed paragraph.\n</paragraph>';
    expect(parseSummaryXML(response)).toEqual({
      headline: 'Trimmed headline.',
      paragraph: 'Trimmed paragraph.',
    });
  });
});

describe('sessions-summary service factory', () => {
  let tmpDir: string;
  let projectId: string;
  let sessionUuid: string;
  let jsonlPath: string;
  let sidecarPath: string;
  let projectPath: string;
  let configDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-summary-svc-'));
    configDir = path.join(tmpDir, 'config');
    projectPath = path.join(tmpDir, 'project');
    projectId = '-tmp-fake-project';
    sessionUuid = '00000000-0000-0000-0000-000000000001';
    const projectDir = path.join(configDir, 'projects', projectId);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(projectPath, { recursive: true });
    jsonlPath = path.join(projectDir, `${sessionUuid}.jsonl`);
    sidecarPath = path.join(projectDir, `${sessionUuid}.summary.json`);
    fs.writeFileSync(jsonlPath, '', 'utf-8');
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('getSummary returns null when no sidecar exists', () => {
    const svc = createSessionsSummaryService({
      jsonlPathFor: () => jsonlPath,
      resolveAccount: () => null,
      runQuery: async () => '',
    });
    expect(svc.getSummary(sessionUuid, projectPath)).toBeNull();
  });

  it('getSummary returns the sidecar when present', () => {
    const summary: SessionSummary = {
      version: 1,
      headline: 'h',
      paragraph: 'p',
      messageCount: 3,
      jsonlSize: 0,
      generatedAt: '2026-05-05T16:00:00.000Z',
      model: 'claude-haiku-4-5',
      accountName: 'Test',
    };
    fs.writeFileSync(sidecarPath, JSON.stringify(summary), 'utf-8');
    const svc = createSessionsSummaryService({
      jsonlPathFor: () => jsonlPath,
      resolveAccount: () => null,
      runQuery: async () => '',
    });
    expect(svc.getSummary(sessionUuid, projectPath)).toEqual(summary);
  });

  it('generateSummary returns null when no account resolves', async () => {
    const svc = createSessionsSummaryService({
      jsonlPathFor: () => jsonlPath,
      resolveAccount: () => null,
      runQuery: async () => '',
    });
    const r = await svc.generateSummary(sessionUuid, projectPath);
    expect(r.status).toBe('skipped');
  });
});

describe('sessions-summary generateSummary (real)', () => {
  let tmpDir: string;
  let jsonlPath: string;
  let projectPath: string;
  let configDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-summary-gen-'));
    configDir = path.join(tmpDir, 'config');
    projectPath = path.join(tmpDir, 'project');
    fs.mkdirSync(path.join(configDir, 'projects', '-tmp-p'), { recursive: true });
    fs.mkdirSync(projectPath, { recursive: true });
    jsonlPath = path.join(configDir, 'projects', '-tmp-p', 'abc.jsonl');
    fs.writeFileSync(
      jsonlPath,
      [
        JSON.stringify({ type: 'user', message: { content: 'hello' } }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hi back' }] },
        }),
      ].join('\n'),
      'utf-8',
    );
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('writes a sidecar with the parsed headline/paragraph and metadata', async () => {
    const runQuery = vi.fn(async () =>
      '<headline>Tested it.</headline><paragraph>It works.</paragraph>',
    );
    const svc = createSessionsSummaryService({
      jsonlPathFor: () => jsonlPath,
      resolveAccount: () => ({
        name: 'Test Acct',
        configDir,
        summarizeOnClose: true,
        summaryModel: 'claude-haiku-4-5',
      }),
      runQuery,
    });

    const result = await svc.generateSummary('abc', projectPath);

    expect(result.status).toBe('generated');
    if (result.status !== 'generated') throw new Error('unreachable');
    expect(result.summary.headline).toBe('Tested it.');
    expect(result.summary.paragraph).toBe('It works.');
    expect(result.summary.messageCount).toBe(2);
    expect(result.summary.model).toBe('claude-haiku-4-5');
    expect(result.summary.accountName).toBe('Test Acct');
    expect(result.summary.jsonlSize).toBe(fs.statSync(jsonlPath).size);
    expect(runQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5',
        cwd: projectPath,
        configDir,
        prompt: expect.stringContaining('USER: hello'),
      }),
    );
    // Sidecar persisted on disk.
    const sidecar = readSidecar(sidecarPathFor(jsonlPath));
    expect(sidecar?.headline).toBe('Tested it.');
  });

  it('returns skipped:toggle-off and skips runQuery when account toggle is off', async () => {
    const runQuery = vi.fn();
    const svc = createSessionsSummaryService({
      jsonlPathFor: () => jsonlPath,
      resolveAccount: () => ({
        name: 'X',
        configDir,
        summarizeOnClose: false,
        summaryModel: 'claude-haiku-4-5',
      }),
      runQuery,
    });
    const r = await svc.generateSummary('abc', projectPath);
    expect(r).toEqual({ status: 'skipped', reason: 'toggle-off' });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('returns skipped:no-model and skips runQuery when summaryModel is null', async () => {
    const runQuery = vi.fn();
    const svc = createSessionsSummaryService({
      jsonlPathFor: () => jsonlPath,
      resolveAccount: () => ({
        name: 'X',
        configDir,
        summarizeOnClose: true,
        summaryModel: null,
      }),
      runQuery,
    });
    const r = await svc.generateSummary('abc', projectPath);
    expect(r).toEqual({ status: 'skipped', reason: 'no-model' });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('returns skipped:no-account and skips runQuery when no account resolves', async () => {
    const runQuery = vi.fn();
    const svc = createSessionsSummaryService({
      jsonlPathFor: () => jsonlPath,
      resolveAccount: () => null,
      runQuery,
    });
    const r = await svc.generateSummary('abc', projectPath);
    expect(r).toEqual({ status: 'skipped', reason: 'no-account' });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('returns unchanged + cached summary without calling runQuery when jsonlSize is unchanged', async () => {
    const runQuery = vi.fn();
    const cachedSummary: SessionSummary = {
      version: 1,
      headline: 'cached',
      paragraph: 'cached para',
      messageCount: 2,
      jsonlSize: fs.statSync(jsonlPath).size,
      generatedAt: '2026-01-01T00:00:00.000Z',
      model: 'claude-haiku-4-5',
      accountName: 'X',
    };
    writeSidecar(sidecarPathFor(jsonlPath), cachedSummary);
    const svc = createSessionsSummaryService({
      jsonlPathFor: () => jsonlPath,
      resolveAccount: () => ({
        name: 'X',
        configDir,
        summarizeOnClose: true,
        summaryModel: 'claude-haiku-4-5',
      }),
      runQuery,
    });
    const result = await svc.generateSummary('abc', projectPath);
    expect(result).toEqual({ status: 'unchanged', summary: cachedSummary });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('returns malformed-response and leaves sidecar untouched when XML is malformed', async () => {
    const existing: SessionSummary = {
      version: 1,
      headline: 'old',
      paragraph: 'old para',
      messageCount: 1,
      jsonlSize: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      model: 'claude-haiku-4-5',
      accountName: 'X',
    };
    writeSidecar(sidecarPathFor(jsonlPath), existing);
    const runQuery = vi.fn(async () => 'no tags here, just prose');
    const svc = createSessionsSummaryService({
      jsonlPathFor: () => jsonlPath,
      resolveAccount: () => ({
        name: 'X',
        configDir,
        summarizeOnClose: true,
        summaryModel: 'claude-haiku-4-5',
      }),
      runQuery,
    });
    const result = await svc.generateSummary('abc', projectPath);
    expect(result).toEqual({ status: 'malformed-response' });
    expect(readSidecar(sidecarPathFor(jsonlPath))).toEqual(existing);
  });

  it('throws when runQuery throws (auth / network errors propagate)', async () => {
    const runQuery = vi.fn(async () => {
      throw new Error('OAuth token expired');
    });
    const svc = createSessionsSummaryService({
      jsonlPathFor: () => jsonlPath,
      resolveAccount: () => ({
        name: 'X',
        configDir,
        summarizeOnClose: true,
        summaryModel: 'claude-haiku-4-5',
      }),
      runQuery,
    });
    await expect(svc.generateSummary('abc', projectPath)).rejects.toThrow(
      /OAuth token expired/,
    );
  });

  it('dedups parallel calls — one runQuery invocation, both promises resolve identically', async () => {
    let calls = 0;
    const runQuery = vi.fn(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return '<headline>x</headline><paragraph>y</paragraph>';
    });
    const svc = createSessionsSummaryService({
      jsonlPathFor: () => jsonlPath,
      resolveAccount: () => ({
        name: 'X',
        configDir,
        summarizeOnClose: true,
        summaryModel: 'claude-haiku-4-5',
      }),
      runQuery,
    });
    const [a, b] = await Promise.all([
      svc.generateSummary('abc', projectPath),
      svc.generateSummary('abc', projectPath),
    ]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(a.status).toBe('generated');
  });

  it('calls onSummaryUpdated after a successful sidecar write', async () => {
    const onSummaryUpdated = vi.fn();
    const runQuery = vi.fn(async () =>
      '<headline>x</headline><paragraph>y</paragraph>',
    );
    const svc = createSessionsSummaryService({
      jsonlPathFor: () => jsonlPath,
      resolveAccount: () => ({
        name: 'X',
        configDir,
        summarizeOnClose: true,
        summaryModel: 'claude-haiku-4-5',
      }),
      runQuery,
      onSummaryUpdated,
    });
    await svc.generateSummary('abc', projectPath);
    expect(onSummaryUpdated).toHaveBeenCalledWith('abc');
  });

  it('does NOT call onSummaryUpdated when XML is malformed', async () => {
    const onSummaryUpdated = vi.fn();
    const runQuery = vi.fn(async () => 'no tags');
    const svc = createSessionsSummaryService({
      jsonlPathFor: () => jsonlPath,
      resolveAccount: () => ({
        name: 'X',
        configDir,
        summarizeOnClose: true,
        summaryModel: 'claude-haiku-4-5',
      }),
      runQuery,
      onSummaryUpdated,
    });
    await svc.generateSummary('abc', projectPath);
    expect(onSummaryUpdated).not.toHaveBeenCalled();
  });

  it('marks truncated: true when the transcript is over the cap', async () => {
    fs.writeFileSync(
      jsonlPath,
      JSON.stringify({
        type: 'user',
        message: { content: 'X'.repeat(800_000) },
      }),
      'utf-8',
    );
    const runQuery = vi.fn(async () =>
      '<headline>big</headline><paragraph>huge.</paragraph>',
    );
    const svc = createSessionsSummaryService({
      jsonlPathFor: () => jsonlPath,
      resolveAccount: () => ({
        name: 'X',
        configDir,
        summarizeOnClose: true,
        summaryModel: 'claude-haiku-4-5',
      }),
      runQuery,
    });
    const result = await svc.generateSummary('abc', projectPath);
    expect(result.status).toBe('generated');
    if (result.status === 'generated') {
      expect(result.summary.truncated).toBe(true);
    }
    const firstCallArgs = (runQuery.mock.calls[0] as unknown) as Array<{ prompt: string }>;
    expect(firstCallArgs[0].prompt).toContain('tokens elided');
  });
});

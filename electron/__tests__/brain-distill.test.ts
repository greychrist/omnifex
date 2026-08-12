import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { distillTranscript, DISTILL_MAX_CHARS } from '../services/brain/distill';

const FIXTURES = join(__dirname, 'fixtures', 'brain');
const normal = readFileSync(join(FIXTURES, 'session-normal.jsonl'), 'utf-8');

describe('distillTranscript', () => {
  it('keeps prompts and assistant prose', () => {
    const { prose } = distillTranscript(normal, 'sess-normal');
    expect(prose).toContain('Add a status probe to the vault registry');
    expect(prose).toContain('Now write the tests for it');
    expect(prose).toContain('it cannot answer "does this vault exist?"');
    expect(prose).toContain('Added seven cases covering never-configured');
  });

  it('never lets a tool result or file content reach the output', () => {
    const { prose } = distillTranscript(normal, 'sess-normal');
    // The single most important assertion in this file: spec §6's "the model
    // must never see raw JSONL" is what keeps whole source files, diffs and
    // command output out of a note that later gets read back into a prompt.
    expect(prose).not.toContain('600 lines of source');
    expect(prose).not.toContain('The file has been updated');
    expect(prose).not.toContain('tool_result');
    expect(prose).not.toContain('old_string');
  });

  it('drops thinking blocks', () => {
    const { prose } = distillTranscript(normal, 'sess-normal');
    expect(prose).not.toContain('Let me look at registry.ts');
  });

  it('drops meta rows and slash-command wrappers', () => {
    const { prose } = distillTranscript(normal, 'sess-normal');
    expect(prose).not.toContain('<command-name>');
    expect(prose).not.toContain('/verify');
  });

  it('anchors turn counting on prompts, not assistant adjacency', () => {
    const { metadata } = distillTranscript(normal, 'sess-normal');
    // Two real prompts. Five assistant rows and three tool-result user rows
    // sit between them; an adjacency-based count would say something else,
    // which is the exact miscount turnDelta.ts documents.
    expect(metadata.promptCount).toBe(2);
    expect(metadata.proseCount).toBe(2);
  });

  it('extracts deterministic metadata with no model', () => {
    const { metadata } = distillTranscript(normal, 'sess-normal');
    expect(metadata.sessionId).toBe('sess-normal');
    expect(metadata.projectPath).toBe('/Users/dev/Repos/omnifex');
    expect(metadata.gitBranch).toBe('main');
    expect(metadata.models).toEqual(['claude-opus-5']);
    expect(metadata.cliVersion).toBe('2.1.228');
    expect(metadata.startedAt).toBe('2026-08-01T10:00:00.000Z');
    expect(metadata.endedAt).toBe('2026-08-01T10:02:30.000Z');
    expect(metadata.durationMs).toBe(150_000);
    expect(metadata.terminalStatus).toBe('completed');
  });

  it('records file PATHS touched, never their contents', () => {
    const { metadata } = distillTranscript(normal, 'sess-normal');
    expect(metadata.filesTouched).toEqual([
      '/Users/dev/Repos/omnifex/electron/services/brain/registry.ts',
    ]);
  });

  it('marks a transcript that died on an API error', () => {
    const err = readFileSync(join(FIXTURES, 'session-startup-error.jsonl'), 'utf-8');
    expect(distillTranscript(err, 'sess-err').metadata.terminalStatus).toBe('error');
  });

  it('truncates oldest-first with an explicit marker', () => {
    const filler = 'x'.repeat(2_000);
    const rows: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      rows.push(
        JSON.stringify({
          type: 'user',
          uuid: `u${i}`,
          sessionId: 's',
          timestamp: '2026-08-01T10:00:00.000Z',
          message: { role: 'user', content: `PROMPT-${i} ${filler}` },
        }),
      );
    }
    const { prose, truncated } = distillTranscript(rows.join('\n'), 's');

    expect(truncated).toBe(true);
    expect(prose.length).toBeLessThanOrEqual(DISTILL_MAX_CHARS);
    // Oldest-first: the tail survives, the head is dropped. A reader that
    // cannot tell it is holding a tail will narrate the session as if it
    // started in the middle.
    expect(prose).toContain('PROMPT-11');
    expect(prose).not.toContain('PROMPT-0 ');
    expect(prose).toContain('earlier turns elided');
  });

  it('yields the tail of a single oversized turn rather than only a marker', () => {
    const one = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-08-01T10:00:00.000Z',
      message: { role: 'user', content: `${'y'.repeat(20_000)}ENDMARKER` },
    });
    const { prose, truncated } = distillTranscript(one, 's');
    expect(truncated).toBe(true);
    expect(prose.length).toBeLessThanOrEqual(DISTILL_MAX_CHARS);
    expect(prose).toContain('ENDMARKER');
  });

  it('keeps every prompt when truncating, and spends what is left on the newest replies', () => {
    const filler = 'z'.repeat(1_500);
    const rows: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      rows.push(
        JSON.stringify({
          type: 'user', uuid: `u${i}`, timestamp: '2026-08-01T10:00:00.000Z',
          message: { role: 'user', content: `PROMPT-${i}` },
        }),
      );
      rows.push(
        JSON.stringify({
          type: 'assistant', uuid: `a${i}`, timestamp: '2026-08-01T10:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: `REPLY-${i} ${filler}` }] },
        }),
      );
    }
    const { prose, truncated } = distillTranscript(rows.join('\n'), 's');

    expect(truncated).toBe(true);
    expect(prose.length).toBeLessThanOrEqual(DISTILL_MAX_CHARS);
    // Every prompt survives — the whole point of the policy. Measured on the
    // real corpus, plain oldest-first dropped ALL of them.
    for (let i = 0; i < 10; i += 1) expect(prose).toContain(`PROMPT-${i}`);
    // Replies are sacrificed oldest-first, so the newest survives.
    expect(prose).toContain('REPLY-9');
    expect(prose).not.toContain('REPLY-0 ');
    expect(prose).toContain('elided');
  });

  it('keeps prompts in transcript order, not grouped at the end', () => {
    const filler = 'z'.repeat(4_000);
    const rows = [
      JSON.stringify({
        type: 'user', uuid: 'u1', timestamp: '2026-08-01T10:00:00.000Z',
        message: { role: 'user', content: 'FIRST-ASK' },
      }),
      JSON.stringify({
        type: 'assistant', uuid: 'a1', timestamp: '2026-08-01T10:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: `OLD-REPLY ${filler}` }] },
      }),
      JSON.stringify({
        type: 'user', uuid: 'u2', timestamp: '2026-08-01T10:00:02.000Z',
        message: { role: 'user', content: 'SECOND-ASK' },
      }),
      JSON.stringify({
        type: 'assistant', uuid: 'a2', timestamp: '2026-08-01T10:00:03.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: `NEW-REPLY ${filler}` }] },
      }),
    ];
    const { prose } = distillTranscript(rows.join('\n'), 's');
    // Reordering would make the prose read as a different conversation than
    // the one that happened.
    expect(prose.indexOf('FIRST-ASK')).toBeLessThan(prose.indexOf('SECOND-ASK'));
  });

  it('still truncates prompts when the prompts alone exceed the ceiling', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({
        type: 'user', uuid: `u${i}`, timestamp: '2026-08-01T10:00:00.000Z',
        message: { role: 'user', content: `P${i} ${'q'.repeat(2_000)}` },
      }),
    );
    const { prose, truncated } = distillTranscript(rows.join('\n'), 's');
    // The ceiling is a hard budget. "Keep every prompt" is a PRIORITY, not an
    // exemption — otherwise one pathological session blows the bound that
    // makes extraction cost predictable.
    expect(truncated).toBe(true);
    expect(prose.length).toBeLessThanOrEqual(DISTILL_MAX_CHARS);
    expect(prose).toContain('P5');
  });

  it('does not mark a transcript under the ceiling as truncated', () => {
    const { truncated, prose } = distillTranscript(normal, 'sess-normal');
    expect(truncated).toBe(false);
    expect(prose).not.toContain('elided');
  });

  it('survives malformed lines without throwing', () => {
    const broken = `not json\n${normal}\n{"unterminated":`;
    expect(() => distillTranscript(broken, 'sess-normal')).not.toThrow();
    expect(distillTranscript(broken, 'sess-normal').metadata.promptCount).toBe(2);
  });

  it('ignores subagent sidechain rows', () => {
    const withSidechain = [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-08-01T10:00:00.000Z',
        isSidechain: true,
        message: { role: 'user', content: 'SUBAGENT TASK BRIEF' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-08-01T10:00:01.000Z',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'SUBAGENT REPLY' }] },
      }),
    ].join('\n');
    const { prose, metadata } = distillTranscript(withSidechain, 's');
    // A subagent's conversation is not the user's. Counting it inflates the
    // turn count and puts a dispatch brief in the vault as if it were typed.
    expect(prose).not.toContain('SUBAGENT');
    expect(metadata.promptCount).toBe(0);
    expect(metadata.proseCount).toBe(0);
  });

  it('reads a prompt whose content is an array of text blocks', () => {
    // The CLI emits both shapes for a typed prompt: a bare string, and an
    // array of content blocks when the message carries more than plain text.
    const arrayForm = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-08-01T10:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'first line' },
          { type: 'text', text: 'second line' },
        ],
      },
    });
    const { prose, metadata } = distillTranscript(arrayForm, 's');
    expect(prose).toBe('USER: first line\nsecond line');
    expect(metadata.promptCount).toBe(1);
  });

  it('ignores an array-form user row that is only a slash-command wrapper', () => {
    const wrapped = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-08-01T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '<command-name>/verify</command-name>' }] },
    });
    expect(distillTranscript(wrapped, 's').metadata.promptCount).toBe(0);
  });

  it('returns empty prose and zero counts for an empty transcript', () => {
    const { prose, metadata, truncated } = distillTranscript('', 'sess-empty');
    expect(prose).toBe('');
    expect(metadata.promptCount).toBe(0);
    expect(metadata.terminalStatus).toBe('unknown');
    expect(truncated).toBe(false);
  });
});

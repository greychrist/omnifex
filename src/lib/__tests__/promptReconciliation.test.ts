import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { classifyJsonlLine } from '@/lib/jsonlClassifier';
import {
  findPendingPromptMatch,
  isCliPromptRecord,
  isPendingPromptPlaceholder,
  reconcilePendingPrompt,
  appendCliRecord,
} from '../promptReconciliation';

/** The optimistic echo useSendPrompt appends on Enter: no uuid, no sessionId. */
const placeholder = (text: string): JsonlNode =>
  ({
    kind: 'user',
    userKind: 'prompt',
    sessionId: '',
    receivedAt: '2026-09-15T10:00:00.000Z',
    raw: {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
  }) as unknown as JsonlNode;

/** The CLI's own record of the same prompt, arriving from the JSONL tail. */
const cliPrompt = (text: string, uuid = 'u-1'): JsonlNode =>
  ({
    kind: 'user',
    userKind: 'prompt',
    sessionId: 's1',
    receivedAt: '2026-09-15T10:00:01.000Z',
    raw: {
      type: 'user',
      uuid,
      sessionId: 's1',
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
  }) as unknown as JsonlNode;

const assistant = (uuid: string): JsonlNode =>
  ({
    kind: 'assistant',
    sessionId: 's1',
    receivedAt: '2026-09-15T10:00:02.000Z',
    raw: { type: 'assistant', uuid, message: { role: 'assistant', content: [] } },
  }) as unknown as JsonlNode;

const toolResult = (): JsonlNode =>
  ({
    kind: 'user',
    userKind: 'tool-result',
    sessionId: 's1',
    receivedAt: '2026-09-15T10:00:03.000Z',
    raw: {
      type: 'user',
      uuid: 'u-tr',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
    },
  }) as unknown as JsonlNode;

describe('isPendingPromptPlaceholder', () => {
  it('is true for the uuid-less optimistic echo', () => {
    expect(isPendingPromptPlaceholder(placeholder('hi'))).toBe(true);
  });

  it('is false once the record carries a uuid', () => {
    expect(isPendingPromptPlaceholder(cliPrompt('hi'))).toBe(false);
  });

  it('is false for non-prompt user records', () => {
    expect(isPendingPromptPlaceholder(toolResult())).toBe(false);
  });

  it('is false for other kinds', () => {
    expect(isPendingPromptPlaceholder(assistant('a1'))).toBe(false);
  });
});

describe('isCliPromptRecord', () => {
  it('is true for a uuid-carrying user prompt', () => {
    expect(isCliPromptRecord(cliPrompt('hi'))).toBe(true);
  });

  it('is false for the placeholder itself', () => {
    expect(isCliPromptRecord(placeholder('hi'))).toBe(false);
  });

  it('is false for tool results', () => {
    expect(isCliPromptRecord(toolResult())).toBe(false);
  });
});

describe('findPendingPromptMatch', () => {
  it('matches the placeholder with identical text', () => {
    const messages = [assistant('a1'), placeholder('build it')];
    expect(findPendingPromptMatch(messages, cliPrompt('build it'))).toBe(1);
  });

  it('returns -1 when no placeholder is pending', () => {
    const messages = [assistant('a1'), cliPrompt('build it')];
    expect(findPendingPromptMatch(messages, cliPrompt('build it', 'u-2'))).toBe(-1);
  });

  it('returns -1 when the text does not match — a real second prompt', () => {
    const messages = [placeholder('build it')];
    expect(findPendingPromptMatch(messages, cliPrompt('something else'))).toBe(-1);
  });

  it('matches the oldest placeholder when two identical prompts are in flight', () => {
    const messages = [placeholder('again'), assistant('a1'), placeholder('again')];
    expect(findPendingPromptMatch(messages, cliPrompt('again'))).toBe(0);
  });

  it('ignores leading/trailing whitespace differences', () => {
    const messages = [placeholder('  build it\n')];
    expect(findPendingPromptMatch(messages, cliPrompt('build it'))).toBe(0);
  });

  it('joins multiple text blocks before comparing', () => {
    const multi = {
      kind: 'user',
      userKind: 'prompt',
      sessionId: '',
      receivedAt: '2026-09-15T10:00:00.000Z',
      raw: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'one' },
            { type: 'text', text: 'two' },
          ],
        },
      },
    } as unknown as JsonlNode;
    expect(findPendingPromptMatch([multi], cliPrompt('one\ntwo'))).toBe(0);
  });

  it('matches a string-valued content payload', () => {
    const stringContent = {
      kind: 'user',
      userKind: 'prompt',
      sessionId: 's1',
      receivedAt: '2026-09-15T10:00:01.000Z',
      raw: {
        type: 'user',
        uuid: 'u-str',
        message: { role: 'user', content: 'build it' },
      },
    } as unknown as JsonlNode;
    expect(findPendingPromptMatch([placeholder('build it')], stringContent)).toBe(0);
  });

  it('ignores image blocks when comparing an image-carrying prompt', () => {
    const withImage = {
      kind: 'user',
      userKind: 'prompt',
      sessionId: '',
      receivedAt: '2026-09-15T10:00:00.000Z',
      raw: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
          ],
        },
      },
    } as unknown as JsonlNode;
    expect(findPendingPromptMatch([withImage], cliPrompt('look at this'))).toBe(0);
  });

  // The CLI rewrites a typed slash command into its own command envelope
  // before persisting it, so the texts are never equal. Verified against
  // real transcripts: `/omnifex-release` lands as
  // `<command-message>omnifex-release</command-message>\n<command-name>/omnifex-release</command-name>`.
  describe('slash commands', () => {
    it('matches a bare slash command against the CLI command envelope', () => {
      const record = cliPrompt(
        '<command-message>omnifex-release</command-message>\n<command-name>/omnifex-release</command-name>',
      );
      expect(findPendingPromptMatch([placeholder('/omnifex-release')], record)).toBe(0);
    });

    it('matches /compact with the CLI arg-bearing envelope', () => {
      const record = cliPrompt(
        '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>',
      );
      expect(findPendingPromptMatch([placeholder('/compact')], record)).toBe(0);
    });

    it('matches a slash command that carried arguments', () => {
      const record = cliPrompt(
        '<command-name>/commit</command-name>\n<command-message>commit</command-message>\n<command-args>--amend</command-args>',
      );
      expect(findPendingPromptMatch([placeholder('/commit --amend')], record)).toBe(0);
    });

    it('does not match a different command', () => {
      const record = cliPrompt('<command-name>/verify</command-name>');
      expect(findPendingPromptMatch([placeholder('/commit')], record)).toBe(-1);
    });

    it('does not treat a prompt merely starting with a slash-like word as a command', () => {
      const record = cliPrompt('<command-name>/commit</command-name>');
      expect(findPendingPromptMatch([placeholder('please /commit for me')], record)).toBe(-1);
    });
  });

  // The cases above hand-build the incoming node as a 'prompt'. These run the
  // real records through the classifier, which is what the JSONL tail does —
  // hand-built nodes are how the two fixes drifted apart unnoticed.
  describe('slash commands, as the classifier sees them', () => {
    const classified = (content: string): JsonlNode =>
      classifyJsonlLine({
        type: 'user',
        uuid: 'u-cmd',
        sessionId: 's1',
        timestamp: '2026-09-28T15:31:47.000Z',
        message: { role: 'user', content },
      })!;

    it('reconciles a skill command echo', () => {
      const record = classified('<command-message>timesheet-review</command-message>\n<command-name>/timesheet-review</command-name>');
      expect(reconcilePendingPrompt([placeholder('/timesheet-review')], record)).toEqual([record]);
    });

    it('reconciles a built-in command echo', () => {
      const record = classified('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>');
      expect(reconcilePendingPrompt([placeholder('/compact')], record)).toEqual([record]);
    });

    it('never reconciles a built-in command\'s stdout', () => {
      const record = classified('<local-command-stdout>Compacted </local-command-stdout>');
      expect(reconcilePendingPrompt([placeholder('/compact')], record)).toBeNull();
    });
  });
});

describe('reconcilePendingPrompt', () => {
  it('replaces the placeholder in place, preserving order', () => {
    const messages = [assistant('a1'), placeholder('build it'), assistant('a2')];
    const record = cliPrompt('build it');
    const next = reconcilePendingPrompt(messages, record);
    expect(next).not.toBeNull();
    expect(next).toHaveLength(3);
    expect(next![1]).toBe(record);
    expect(next![0]).toBe(messages[0]);
    expect(next![2]).toBe(messages[2]);
  });

  it('does not mutate the input array', () => {
    const messages = [placeholder('build it')];
    reconcilePendingPrompt(messages, cliPrompt('build it'));
    expect(isPendingPromptPlaceholder(messages[0])).toBe(true);
  });

  it('returns null when there is nothing to reconcile, so the caller appends', () => {
    const messages = [assistant('a1')];
    expect(reconcilePendingPrompt(messages, cliPrompt('build it'))).toBeNull();
  });

  it('returns null for a node that is not a CLI prompt record', () => {
    const messages = [placeholder('build it')];
    expect(reconcilePendingPrompt(messages, toolResult())).toBeNull();
  });

  it('reconciles only once for a repeated prompt', () => {
    const messages = [placeholder('again'), placeholder('again')];
    const first = reconcilePendingPrompt(messages, cliPrompt('again', 'u-1'))!;
    expect(isPendingPromptPlaceholder(first[0])).toBe(false);
    expect(isPendingPromptPlaceholder(first[1])).toBe(true);
    const second = reconcilePendingPrompt(first, cliPrompt('again', 'u-2'))!;
    expect(second.every((m) => !isPendingPromptPlaceholder(m))).toBe(true);
  });
});

describe('appendCliRecord — a queued prompt does not jump ahead of the answer before it', () => {
  // The turn's final answer is written to the JSONL before the CLI emits
  // `result` on stdout. `result` drains the queue at once, appending the next
  // prompt's echo — but the answer's record only reaches the renderer on the
  // tail's next poll, after the echo. Appended blindly it lands BELOW the
  // prompt it preceded. Observed in session cc50c6f6 on 2026-10-02: answer
  // written 19:25:48.199, queued prompt enqueued 19:25:48.477.
  const at = (node: JsonlNode, receivedAt: string): JsonlNode =>
    ({ ...node, receivedAt }) as JsonlNode;
  const echo = at(placeholder('next question'), '2026-09-15T10:00:05.000Z');

  it('puts a record written before the echo was sent above the echo', () => {
    const answer = at(assistant('a-final'), '2026-09-15T10:00:04.800Z');
    const next = appendCliRecord([assistant('a-1'), echo], answer);
    expect(next.map((n) => n.kind)).toEqual(['assistant', 'assistant', 'user']);
    expect(next[1]).toBe(answer);
    expect(next[2]).toBe(echo);
  });

  it('appends a record written after the echo — the new turn — as normal', () => {
    const reply = at(assistant('a-new'), '2026-09-15T10:00:06.000Z');
    expect(appendCliRecord([echo], reply)).toEqual([echo, reply]);
  });

  it('appends normally when no prompt is waiting on its record', () => {
    const answer = at(assistant('a-final'), '2026-09-15T10:00:04.800Z');
    const prior = cliPrompt('earlier');
    expect(appendCliRecord([prior], answer)).toEqual([prior, answer]);
  });

  // Only the CLI's persisted records are ordered by the file. A node without
  // a uuid — a Codex event, a synthetic marker — has no file position to
  // honour, and arrives in the order it happened.
  it('leaves nodes without a uuid where they arrive', () => {
    const marker = {
      kind: 'control-change',
      control: 'permission',
      value: 'plan',
      sessionId: 't',
      receivedAt: '2026-09-15T10:00:04.000Z',
    } as unknown as JsonlNode;
    expect(appendCliRecord([echo], marker)).toEqual([echo, marker]);
  });

  it('keeps file order among several hoisted records', () => {
    const a = at(assistant('a-x'), '2026-09-15T10:00:04.100Z');
    const b = at(toolResult(), '2026-09-15T10:00:04.200Z');
    const once = appendCliRecord([echo], a);
    expect(appendCliRecord(once, b)).toEqual([a, b, echo]);
  });

  it('does not mutate its input', () => {
    const input = [echo];
    appendCliRecord(input, at(assistant('a-final'), '2026-09-15T10:00:04.800Z'));
    expect(input).toEqual([echo]);
  });
});

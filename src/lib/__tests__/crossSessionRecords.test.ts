import { describe, it, expect } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { classifyJsonlLine } from '../jsonlClassifier';
import { classifyStandaloneKind } from '../messageKind';
import { createDefaultConfig } from '../messageRenderingConfig';
import { modernLineOf } from '../modernLines';
import { transcriptItems } from '../transcriptItems';

const cfg = createDefaultConfig();

const WRAPPED = 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/55889.sock" from-name="omnifex-29" from-mode="prompting">\ngreg says hi\n</cross-session-message>\n\nThis came from another Claude session — not typed by your user.';

function peerRecord(extra: Record<string, unknown> = {}): JsonlNode {
  return classifyJsonlLine({
    type: 'user',
    uuid: 'peer-1',
    timestamp: '2026-11-25T04:01:31.264Z',
    sessionId: 's1',
    isMeta: true,
    promptSource: 'system',
    turnOrigin: 'peer',
    message: { role: 'user', content: WRAPPED },
    origin: {
      kind: 'peer', from: 'uds:/tmp/cc-socks/55889.sock', name: 'omnifex-29',
      fromMode: 'prompting', body: 'greg says hi', verifiedLocal: true,
    },
    ...extra,
  })!;
}

function lifecycleFrame(state = 'completed'): JsonlNode {
  return classifyJsonlLine({
    type: 'command_lifecycle',
    command_uuid: 'peer-1',
    state,
    uuid: 'lc-1',
    session_id: 's1',
    receivedAt: '2026-11-25T04:01:45.585Z',
  })!;
}

describe('a message from another session', () => {
  it('classifies as its own user kind, not a hidden meta record or a prompt', () => {
    const node = peerRecord();
    expect(node).toMatchObject({ kind: 'user', userKind: 'peer-message' });
    expect(classifyStandaloneKind(node, [node])).toBe('user.peerMessage');
  });

  it('draws as a line naming the sender, with the message body instead of the wrapper', () => {
    const node = peerRecord();
    expect(modernLineOf(node, [node], cfg)).toMatchObject({
      icon: 'Mail', title: 'Message from omnifex-29', detail: 'greg says hi',
    });
  });

  it('keeps a long body open rather than folding it away', () => {
    const body = 'line one\nline two\nline three';
    const node = peerRecord({ origin: { kind: 'peer', name: 'omnifex-29', body } });
    const line = modernLineOf(node, [node], cfg);
    expect(line).toMatchObject({ title: 'Message from omnifex-29', body });
    expect(line.fold).toBeFalsy();
  });

  it('falls back to the sender address when the session has no name', () => {
    const node = peerRecord({ origin: { kind: 'peer', from: 'uds:/tmp/cc-socks/1.sock', body: 'hi' } });
    expect(modernLineOf(node, [node], cfg).title).toBe('Message from uds:/tmp/cc-socks/1.sock');
  });

  it('shows in Standard, as a line and not as your prompt', () => {
    const node = peerRecord();
    const items = transcriptItems([node], cfg, 'standard');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'line', line: { title: 'Message from omnifex-29' } });
  });
});

describe('command_lifecycle', () => {
  it('has its own kind, so it never draws as an unrecognized record', () => {
    const node = lifecycleFrame();
    expect(classifyStandaloneKind(node, [node])).toBe('queue-lifecycle');
    expect(modernLineOf(node, [node], cfg)).toMatchObject({ title: 'Queued command: completed' });
    expect(modernLineOf(node, [node], cfg).tone).toBeUndefined();
  });

  it('is hidden in Standard and shown in Expanded', () => {
    const node = lifecycleFrame();
    expect(transcriptItems([node], cfg, 'standard')).toEqual([]);
    expect(transcriptItems([node], cfg, 'expanded')).toHaveLength(1);
  });
});

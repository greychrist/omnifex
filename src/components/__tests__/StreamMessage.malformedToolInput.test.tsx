// @vitest-environment jsdom
//
// Claude Code 2.1.229 shipped "Fixed a crash to the error screen (including on
// `--resume` of the affected session) when a tool call had a non-string `glob`,
// `file_path`, or `command` value." The CLI now tolerates the value rather than
// rejecting it upstream, so the malformed `tool_use` still lands in the JSONL
// we render. Our widget branches guarded on truthiness only, so a numeric
// `file_path` reached `getLanguage()` → `path.split('.')` → TypeError, which
// blanked the whole app (nearest boundary was app-level) and blanked it again
// on every replay of that session.
//
// Contract: a malformed field falls through to the raw-JSON tool display.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

vi.mock('@/contexts/MessageRenderingContext', async () => {
  const { createDefaultConfig } = await import('@/lib/messageRenderingConfig');
  return {
    useMessageRenderingConfig: () => ({
      config: createDefaultConfig(),
      setConfig: () => {},
      loaded: true,
    }),
  };
});

vi.mock('@/components/StreamMessage/MessageFrame', () => ({
  MessageFrame: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'message-frame' }, children),
}));

vi.mock('@/components/CardActionBar', () => ({
  CardActionBar: () => null,
  CardActionButton: () => null,
  CardActionDivider: () => null,
}));

import { StreamMessage } from '../StreamMessage';
import type { JsonlNode } from '@/types/jsonl';

afterEach(() => { cleanup(); });

function toolUseNode(name: string, input: unknown): JsonlNode {
  return {
    kind: 'assistant',
    sessionId: 'sess-1',
    receivedAt: '2026-08-13T10:00:00Z',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu-1', name, input }],
        stop_reason: null,
      },
    },
  } as unknown as JsonlNode;
}

function renderNode(node: JsonlNode) {
  return render(<StreamMessage message={node} streamMessages={[node]} />);
}

describe('StreamMessage — malformed tool_use input (CLI 2.1.229 class)', () => {
  const cases: { tool: string; input: Record<string, unknown>; what: string }[] = [
    { tool: 'Read', what: 'numeric file_path', input: { file_path: 123 } },
    { tool: 'Edit', what: 'numeric file_path', input: { file_path: 123, old_string: 'a', new_string: 'b' } },
    { tool: 'Edit', what: 'object old_string', input: { file_path: '/tmp/a.ts', old_string: { a: 1 }, new_string: 'b' } },
    { tool: 'Write', what: 'array file_path', input: { file_path: ['/tmp/a.ts'], content: 'x' } },
    { tool: 'Write', what: 'object content', input: { file_path: '/tmp/a.ts', content: { a: 1 } } },
    { tool: 'MultiEdit', what: 'numeric file_path', input: { file_path: 7, edits: [{ old_string: 'a', new_string: 'b' }] } },
    { tool: 'MultiEdit', what: 'non-array edits', input: { file_path: '/tmp/a.ts', edits: 'nope' } },
    { tool: 'Bash', what: 'object command', input: { command: { cmd: 'ls' } } },
    { tool: 'Glob', what: 'array pattern', input: { pattern: ['*.ts'] } },
    { tool: 'Grep', what: 'numeric pattern', input: { pattern: 42 } },
    { tool: 'LS', what: 'numeric path', input: { path: 5 } },
    { tool: 'WebFetch', what: 'object url', input: { url: { href: 'x' }, prompt: 'p' } },
    { tool: 'WebSearch', what: 'array query', input: { query: ['a'] } },
  ];

  for (const { tool, input, what } of cases) {
    it(`renders ${tool} with a ${what} as the raw-JSON fallback instead of throwing`, () => {
      expect(() => renderNode(toolUseNode(tool, input))).not.toThrow();
      // The generic fallback labels the block and prints the payload.
      expect(screen.getByText(/Using tool:/)).toBeTruthy();
      expect(screen.getByText(tool)).toBeTruthy();
    });
  }

  it('still renders the real widget when the fields are well-formed strings', () => {
    renderNode(toolUseNode('Read', { file_path: '/tmp/well-formed.ts' }));
    // The Read widget shows the path and NOT the generic fallback label.
    expect(screen.queryByText(/Using tool:/)).toBeNull();
    expect(screen.getByText(/well-formed\.ts/)).toBeTruthy();
  });

  it('treats an empty-string field as no value (pre-existing fall-through)', () => {
    renderNode(toolUseNode('Bash', { command: '' }));
    expect(screen.getByText(/Using tool:/)).toBeTruthy();
  });
});

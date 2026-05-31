// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

// Mock useTheme so the component doesn't throw without a ThemeProvider.
vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

// Mock MessageRenderingContext with a minimal default config.
vi.mock('@/contexts/MessageRenderingContext', async () => {
  const { createDefaultConfig } = await import('@/lib/messageRenderingConfig');
  return {
    useMessageRenderingConfig: () => ({ config: createDefaultConfig(), setConfig: () => {}, loaded: true }),
  };
});

// Mock subcomponents that have their own heavy dependencies so the test
// stays focused on the completion-band logic.
vi.mock('@/components/StreamMessage/MessageFrame', () => ({
  MessageFrame: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'message-frame' }, children),
}));

vi.mock('@/components/CardActionBar', () => ({
  CardActionBar: () => null,
  CardActionButton: () => null,
  CardActionDivider: () => null,
}));

// turnDuration returns null for most test cases (no preceding user.prompt)
// unless we wire up a full message array. We test the band by controlling
// whether the stop_reason is terminal and checking rendered output.
import { StreamMessage } from '../StreamMessage';
import type { JsonlNode } from '@/types/jsonl';

afterEach(() => { cleanup(); });

function makeAssistantNode(opts: {
  stop_reason?: string | null;
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
}): Extract<JsonlNode, { kind: 'assistant' }> {
  return {
    kind: 'assistant',
    sessionId: 'sess-1',
    receivedAt: '2026-05-27T10:00:00Z',
    raw: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: opts.text ?? 'Hello from Claude' }],
        stop_reason: opts.stop_reason ?? null,
        usage: {
          input_tokens: opts.inputTokens ?? 100,
          output_tokens: opts.outputTokens ?? 50,
          cache_read_input_tokens: opts.cacheRead ?? 0,
        },
      },
    },
  };
}

describe('AssistantCompletionBand', () => {
  it('renders token counts when stop_reason is end_turn', () => {
    const node = makeAssistantNode({ stop_reason: 'end_turn', inputTokens: 200, outputTokens: 80 });
    render(
      <StreamMessage
        message={node}
        streamMessages={[node]}
      />,
    );
    // Should show "200 in / 80 out" in the band
    expect(screen.getByText(/200 in \/ 80 out/)).toBeTruthy();
  });

  it('renders cost when stop_reason is end_turn and accountType is not max', () => {
    const node = makeAssistantNode({ stop_reason: 'end_turn', inputTokens: 1000, outputTokens: 500 });
    render(
      <StreamMessage
        message={node}
        streamMessages={[node]}
        accountType="pro"
      />,
    );
    // cost = 1000 * 0.000003 + 500 * 0.000015 = 0.003 + 0.0075 = 0.0105 → $0.0105
    expect(screen.getByText(/\$0\.0105/)).toBeTruthy();
  });

  it('hides cost when accountType is max', () => {
    const node = makeAssistantNode({ stop_reason: 'end_turn', inputTokens: 1000, outputTokens: 500 });
    render(
      <StreamMessage
        message={node}
        streamMessages={[node]}
        accountType="max"
      />,
    );
    // Cost should not appear
    expect(screen.queryByText(/\$0\.0105/)).toBeNull();
    // But token counts still appear
    expect(screen.getByText(/1000 in \/ 500 out/)).toBeTruthy();
  });

  it('does NOT render the band when stop_reason is null', () => {
    const node = makeAssistantNode({ stop_reason: null });
    render(
      <StreamMessage
        message={node}
        streamMessages={[node]}
      />,
    );
    // No band: token display text should not appear
    expect(screen.queryByText(/in \/ \d+ out/)).toBeNull();
  });

  it('does NOT render the band when stop_reason is absent (undefined)', () => {
    const node = makeAssistantNode({ stop_reason: undefined });
    render(
      <StreamMessage
        message={node}
        streamMessages={[node]}
      />,
    );
    expect(screen.queryByText(/in \/ \d+ out/)).toBeNull();
  });

  it('renders the band for all terminal stop_reason values', () => {
    const terminalReasons = [
      'end_turn',
      'stop_sequence',
      'max_tokens',
      'refusal',
      'model_context_window_exceeded',
    ];
    for (const reason of terminalReasons) {
      const node = makeAssistantNode({ stop_reason: reason, inputTokens: 10, outputTokens: 5 });
      const { unmount } = render(
        <StreamMessage message={node} streamMessages={[node]} />,
      );
      expect(screen.getByText(/10 in \/ 5 out/), `expected band for stop_reason="${reason}"`).toBeTruthy();
      unmount();
    }
  });

  it('shows cache-read count in the band when non-zero', () => {
    const node = makeAssistantNode({ stop_reason: 'end_turn', inputTokens: 100, outputTokens: 20, cacheRead: 500 });
    render(
      <StreamMessage message={node} streamMessages={[node]} />,
    );
    expect(screen.getByText(/500 cached/)).toBeTruthy();
  });

  it('does NOT show cache count in the band when zero', () => {
    const node = makeAssistantNode({ stop_reason: 'end_turn', inputTokens: 100, outputTokens: 20, cacheRead: 0 });
    render(
      <StreamMessage message={node} streamMessages={[node]} />,
    );
    expect(screen.queryByText(/cached/)).toBeNull();
  });
});

// The CLI `result` row (kind:'unknown', raw.type:'result') renders nothing
// (StreamMessage's unknown branch returns null), so the renderer must NOT
// suppress the assistant's own text just because it duplicates the result
// string — doing so erased the final message entirely.
function makeResultNode(resultText: string): JsonlNode {
  return {
    kind: 'unknown',
    receivedAt: '2026-05-27T10:00:01Z',
    raw: { type: 'result', subtype: 'success', is_error: false, result: resultText },
  } as unknown as JsonlNode;
}

describe('final assistant text vs. result-row de-dup', () => {
  it('renders the assistant text even when it equals a following result row', () => {
    const assistant = makeAssistantNode({ stop_reason: null, text: 'Final answer for the user.' });
    const result = makeResultNode('Final answer for the user.');
    render(
      <StreamMessage message={assistant} streamMessages={[assistant, result]} />,
    );
    expect(screen.getByText(/Final answer for the user\./)).toBeTruthy();
  });
});

function makeUserTextNode(text: string): JsonlNode {
  return {
    kind: 'user',
    userKind: 'prompt',
    sessionId: 'sess-1',
    receivedAt: '2026-05-27T10:00:00Z',
    raw: {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
  } as unknown as JsonlNode;
}

describe('user-role messages render markdown (matching assistant styling)', () => {
  it('renders a markdown heading as an <h1>, not raw "# ..." text', () => {
    // System Context / skill-injection bodies (and user text in general) used to
    // render as raw whitespace-pre-wrap text — markdown was printed literally.
    const node = makeUserTextNode('# Big Heading\n\nSome **bold** body.');
    const { container } = render(<StreamMessage message={node} streamMessages={[node]} />);

    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toContain('Big Heading');
    expect(container.querySelector('strong')?.textContent).toContain('bold');
  });

  it('renders a fenced ```markdown block through the Rendered/Source tabbed control', () => {
    const fenced = '```markdown\n# Inside a fence\n```';
    const node = makeUserTextNode(fenced);
    render(<StreamMessage message={node} streamMessages={[node]} />);

    // MarkdownBlock exposes the Rendered/Source pill toggle.
    expect(screen.getByRole('button', { name: 'Rendered' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Source' })).toBeTruthy();
  });
});

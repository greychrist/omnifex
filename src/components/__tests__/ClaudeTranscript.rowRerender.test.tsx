// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import { renderProfiler } from '@/lib/renderProfiler';

vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));
vi.mock('@/contexts/MessageRenderingContext', async () => {
  const { createDefaultConfig } = await import('@/lib/messageRenderingConfig');
  const config = createDefaultConfig();
  return {
    useMessageRenderingConfig: () => ({ config, setConfig: () => {}, loaded: true }),
    MessageRenderingOverrideProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});
vi.mock('@/contexts/AutoScrollContext', () => ({
  useAutoScroll: () => ({ followPx: 200 }),
}));
vi.mock('@/contexts/SessionGaugesContext', () => ({
  useSessionGauges: () => ({
    contextTimelineEnabled: false,
    setContextTimelineEnabled: () => {},
    contextJump: { thresholdTokens: 50_000 },
    contextPressure: { enabled: true, mode: 'tokens', value: 250_000 },
  }),
}));

import { ClaudeTranscript } from '@/components/claude/ClaudeTranscript';
import { TooltipProvider } from '@/components/ui/tooltip-modern';

afterEach(() => {
  cleanup();
  renderProfiler.setEnabled(false);
});
beforeEach(() => {
  renderProfiler.setEnabled(true);
});

const ts = (i: number) => new Date(Date.UTC(2026, 9, 13, 0, 0, i)).toISOString();

const prompt = (i: number): JsonlNode => ({
  kind: 'user',
  userKind: 'prompt',
  sessionId: 's',
  receivedAt: ts(i),
  raw: {
    type: 'user',
    uuid: `u-${i}`,
    timestamp: ts(i),
    message: { role: 'user', content: [{ type: 'text', text: `prompt ${i}` }] },
  } as never,
});

const reply = (i: number, content: unknown[] = [{ type: 'text', text: `**reply** ${i}` }]): JsonlNode => ({
  kind: 'assistant',
  sessionId: 's',
  receivedAt: ts(i),
  raw: {
    type: 'assistant',
    uuid: `a-${i}`,
    timestamp: ts(i),
    message: { role: 'assistant', content, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
  } as never,
});

const toolResult = (i: number, toolUseId: string): JsonlNode => ({
  kind: 'user',
  userKind: 'tool-result',
  sessionId: 's',
  receivedAt: ts(i),
  raw: {
    type: 'user',
    uuid: `r-${i}`,
    timestamp: ts(i),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] },
  } as never,
});

function conversation(turns: number): JsonlNode[] {
  const out: JsonlNode[] = [];
  for (let i = 0; i < turns; i++) out.push(prompt(i * 2), reply(i * 2 + 1));
  return out;
}

function Harness({ messages, viewMode }: { messages: JsonlNode[]; viewMode: 'expanded' | 'standard' }) {
  const onResend = React.useCallback(() => {}, []);
  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  const isNearBottomRef = React.useRef(true);
  return (
    <TooltipProvider>
      <ClaudeTranscript
        messages={messages}
        viewMode={viewMode}
        accountType={undefined}
        onResend={onResend}
        waitingForPermission={false}
        outstandingWork={false}
        hasInflightAssistant={false}
        currentActivity="Thinking"
        contextLimit={200_000}
        error={null}
        tabId="tab-1"
        messagesEndRef={messagesEndRef}
        isNearBottomRef={isNearBottomRef}
      />
    </TooltipProvider>
  );
}

function rowRendersOnUpdate(before: JsonlNode[], after: JsonlNode[], viewMode: 'expanded' | 'standard') {
  const { rerender } = render(<Harness messages={before} viewMode={viewMode} />);
  renderProfiler.begin('append');
  rerender(<Harness messages={after} viewMode={viewMode} />);
  const report = renderProfiler.end();
  return report?.renders.find((r) => r.name === 'ModernTranscriptItem')?.count ?? 0;
}

describe.each(['expanded', 'standard'] as const)('ClaudeTranscript row re-renders (%s)', (viewMode) => {
  it('renders only the new row when a record is appended', () => {
    const before = conversation(40);
    const after = [...before, prompt(100)];

    expect(rowRendersOnUpdate(before, after, viewMode)).toBe(1);
  });

  it('leaves every older row alone when a tool result lands', () => {
    const call = reply(200, [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]);
    const before = [...conversation(40), prompt(199), call];
    const after = [...before, toolResult(201, 'toolu_1')];

    expect(rowRendersOnUpdate(before, after, viewMode)).toBeLessThanOrEqual(1);
  });

  // The CLI's stream `init` is inserted before the first user record, not
  // appended, on every process start.
  it('renders only the inserted row when a record lands above every other', () => {
    const before = conversation(40);
    const init: JsonlNode = {
      kind: 'cli-stream-init',
      sessionId: 's',
      receivedAt: ts(500),
      raw: { type: 'system', subtype: 'init', session_id: 's' } as never,
    };
    const after = [init, ...before];

    expect(rowRendersOnUpdate(before, after, viewMode)).toBeLessThanOrEqual(1);
  });
});

it('re-renders the work row when its tool result lands', () => {
  const call = reply(200, [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]);
  const before = [...conversation(40), prompt(199), call];
  const after = [...before, toolResult(201, 'toolu_1')];

  expect(rowRendersOnUpdate(before, after, 'standard')).toBe(1);
});

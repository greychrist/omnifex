// @vitest-environment jsdom
//
// The Modern chat format: prompt bubbles, prose, and each run of work folded
// into one Chain of Thought that opens onto the regular tool rows.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import { createDefaultConfig } from '@/lib/messageRenderingConfig';
import { MessageRenderingPreviewProvider } from '@/contexts/MessageRenderingContext';

vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));
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
vi.mock('@/components/StreamMessage', () => ({
  StreamMessage: ({ message }: { message: JsonlNode }) => <div data-stream-row={message.kind} />,
}));
vi.mock('@/components/InflightAssistantBubble', () => ({
  InflightAssistantBubble: () => <div data-classic-live-answer />,
}));

import { ClaudeTranscript } from '@/components/claude/ClaudeTranscript';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import { TooltipProvider } from '@/components/ui/tooltip-modern';

afterEach(() => { cleanup(); useClaudeSessionStore.getState().__resetForTests(); });

const prompt = {
  kind: 'user', userKind: 'prompt', sessionId: 's', receivedAt: '2026-10-28T10:00:00Z',
  raw: { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'Fix the parser' }] } },
} as unknown as JsonlNode;
const assistant = (uuid: string, blocks: unknown[]) => ({
  kind: 'assistant', sessionId: 's', receivedAt: '2026-10-28T10:00:01Z',
  raw: { type: 'assistant', uuid, message: { role: 'assistant', content: blocks, stop_reason: null } },
} as unknown as JsonlNode);
const toolResult = {
  kind: 'user', userKind: 'tool-result', sessionId: 's', receivedAt: '',
  raw: { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
} as unknown as JsonlNode;

const messages = [
  prompt,
  assistant('a1', [{ type: 'thinking', thinking: 'Check the regex first.', signature: 's' }]),
  assistant('a2', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }]),
  toolResult,
  assistant('a3', [{ type: 'text', text: 'All **green**.' }]),
];

function renderModern(outstandingWork = false, rows: JsonlNode[] = messages, onResend: (text: string, images?: string[]) => void = () => {}, waitingForPermission = false) {
  return render(
    <MessageRenderingPreviewProvider config={createDefaultConfig()}>
      <TooltipProvider>
        <ClaudeTranscript
          messages={rows}
          viewMode="modern"
          accountType={undefined}
          onResend={onResend}
          waitingForPermission={waitingForPermission}
          outstandingWork={outstandingWork}
          hasInflightAssistant={false}
          currentActivity="Thinking"
          totalTokens={0}
          contextLimit={200_000}
          error={null}
          tabId="tab-1"
          messagesEndRef={React.createRef<HTMLDivElement>()}
          isNearBottomRef={{ current: true }}
        />
      </TooltipProvider>
    </MessageRenderingPreviewProvider>,
  );
}

describe('ClaudeTranscript — Modern chat format', () => {
  it('draws the prompt, one folded chain of thought, and the answer', () => {
    const { container } = renderModern();
    expect(screen.getByText('Fix the parser')).toBeInTheDocument();
    const header = screen.getByRole('button', { name: /Worked in 2 steps/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('green')).toBeInTheDocument();
    // Folded: no tool rows drawn yet.
    expect(container.querySelectorAll('[data-stream-row]')).toHaveLength(0);
  });

  it('opens onto the steps, and a step onto the regular tool row', () => {
    const { container } = renderModern();
    fireEvent.click(screen.getByRole('button', { name: /Worked in 2 steps/ }));
    // A finished thought is shadcn's Reasoning line, closed until opened.
    expect(screen.queryByText('Check the regex first.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Thought/ }));
    expect(screen.getByText('Check the regex first.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Run the tests/ }));
    expect(container.querySelectorAll('[data-stream-row="assistant"]')).toHaveLength(1);
  });

  it('keeps the run open while the turn is still working on it', () => {
    // Mid-turn: the work is the last thing in the transcript, a tool running.
    renderModern(true, messages.slice(0, 3));
    expect(screen.getByText('Working', { selector: '.modern-shimmer' })).toBeInTheDocument();
    expect(screen.getByText('Run the tests', { selector: '.modern-shimmer' })).toBeInTheDocument();
  });

  it('types out the thought being had as Reasoning: Thinking, open', () => {
    useClaudeSessionStore.getState().setInflightThinkingText('tab-1', 'Looking at the regex');
    renderModern(true, messages.slice(0, 3));
    expect(screen.getByText('Thinking', { selector: '.modern-shimmer' })).toBeInTheDocument();
    expect(screen.getByText('Looking at the regex')).toBeInTheDocument();
  });

  it('shows the live thought on its own when the turn has no run yet', () => {
    useClaudeSessionStore.getState().setInflightThinkingText('tab-1', 'Where to start');
    renderModern(true, messages.slice(0, 1));
    expect(screen.getByText('Thinking', { selector: '.modern-shimmer' })).toBeInTheDocument();
    expect(screen.getByText('Where to start')).toBeInTheDocument();
  });

  it('says Working, not the old typing dots, while a turn runs with nothing to show yet', () => {
    const { container } = renderModern(true, messages.slice(0, 1));
    expect(screen.getByText('Working', { selector: '.modern-shimmer' })).toBeInTheDocument();
    expect(container.querySelector('.typing-dot')).toBeNull();
  });

  it('treats a recorded thought as finished: it has already ended when its record lands', () => {
    renderModern(true, messages.slice(0, 2));
    expect(screen.getByRole('button', { name: /^Thought/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes a finished thought to "Thought" with no run header', () => {
    renderModern(false, [...messages.slice(0, 2), messages[4]]);
    expect(screen.getByRole('button', { name: /^Thought/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Worked/)).toBeNull();
  });

  it('marks the prompt as a jump target', () => {
    const { container } = renderModern();
    expect(container.querySelectorAll('[data-transcript-prompt]')).toHaveLength(1);
    expect(container.querySelector('[data-message-uuid="u1"]')).not.toBeNull();
  });

  it('sets the transcript in Geist, as the shadcn examples are', () => {
    const { container } = renderModern();
    expect(container.querySelector('.modern-format')).not.toBeNull();
  });

  it('sets the answer at the example\'s size: 14px on a 20px line', () => {
    renderModern();
    // Sized by `.modern-format .modern-answer` in styles.css (jsdom applies
    // no stylesheet; the 14px/20px was measured in a browser).
    const answer = screen.getByText('green').closest('.prose');
    expect(answer?.className).toContain('modern-answer');
    expect(answer?.closest('.modern-format')).not.toBeNull();
  });

  it('leaves no skeleton behind once the transcript has rendered', () => {
    renderModern();
    expect(screen.queryByText('Loading conversation')).toBeNull();
    expect(screen.getByText('Fix the parser')).toBeInTheDocument();
  });

  it('streams the answer in the Modern style, not the classic card it would later be swapped for', () => {
    useClaudeSessionStore.getState().setInflightAssistantText('tab-1', 'u', 'Halfway through the **answer**', null);
    const { container } = renderModern(true, messages.slice(0, 4));
    expect(container.querySelector('[data-classic-live-answer]')).toBeNull();
    const live = screen.getByText('answer').closest('.modern-answer');
    expect(live).not.toBeNull();
  });

  it('offers Resend on your own message, as the classic card does', () => {
    const onResend = vi.fn();
    renderModern(false, messages, onResend);
    fireEvent.click(screen.getByRole('button', { name: 'Resend message' }));
    expect(onResend).toHaveBeenCalledWith('Fix the parser', undefined);
  });

  it('draws a stop as one red line with the triangle, not a card', () => {
    const interrupt = {
      kind: 'user', userKind: 'interrupt', sessionId: 's', receivedAt: '',
      raw: { type: 'user', uuid: 'i1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    } as unknown as JsonlNode;
    const { container } = renderModern(false, [...messages.slice(0, 3), interrupt]);
    const line = screen.getByRole('alert');
    expect(line).toHaveTextContent('Response interrupted');
    expect(line.className).toContain('text-destructive');
    expect(line.querySelector('svg')).not.toBeNull();
    expect(container.querySelectorAll('[data-stream-row]')).toHaveLength(0);
  });

  it('puts the thought\'s token estimate on its line, in parentheses', () => {
    const tokens = {
      kind: 'system', subtype: 'thinking_tokens', sessionId: 's', receivedAt: '',
      raw: { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 608 },
    } as unknown as JsonlNode;
    renderModern(false, [messages[0], tokens, messages[1], messages[4]]);
    expect(screen.getByText('(~608 tokens)')).toBeInTheDocument();
  });

  it('has the view button on your message and on the answer, opening the raw record', () => {
    renderModern();
    const views = screen.getAllByRole('button', { name: 'View raw JSON' });
    expect(views).toHaveLength(2);
    fireEvent.click(views[0]);
    expect(screen.getByText(/"uuid": "u1"/)).toBeInTheDocument();
  });

  it('shows the time with seconds in the hover row', () => {
    const { container } = renderModern();
    const times = [...container.querySelectorAll('span')].map((e) => e.textContent ?? '').filter((t) => /\d:\d{2}/.test(t));
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) expect(t).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it('shows no Working line while a question or permission waits on you', () => {
    renderModern(true, messages.slice(0, 1), () => {}, true);
    expect(screen.queryByText('Working', { selector: '.modern-shimmer' })).toBeNull();
  });
});

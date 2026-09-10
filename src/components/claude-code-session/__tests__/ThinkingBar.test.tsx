// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import { ThinkingBar } from '../ThinkingBar';

const thinkingTokens = (estimated_tokens: number): JsonlNode =>
  ({
    kind: 'system', subtype: 'thinking_tokens', sessionId: '', receivedAt: '',
    raw: { type: 'system', subtype: 'thinking_tokens', estimated_tokens },
  }) as unknown as JsonlNode;

const assistantText = (text: string): JsonlNode =>
  ({
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }) as unknown as JsonlNode;

describe('ThinkingBar', () => {
  it('shows the running token count while thinking', () => {
    render(<ThinkingBar messages={[thinkingTokens(1300)]} isLive />);
    expect(screen.getByRole('status').textContent).toContain('Thinking');
    expect(screen.getByText('1,300')).toBeTruthy();
  });

  it('renders nothing once the burst ends', () => {
    // No turn-end plumbing: the assistant's first block is the burst
    // terminator, so the bar collapses to zero height on its own.
    const { container } = render(
      <ThinkingBar messages={[thinkingTokens(1300), assistantText('done')]} isLive />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the transcript has no thinking at all', () => {
    const { container } = render(<ThinkingBar messages={[assistantText('yo')]} isLive />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the turn is not live', () => {
    // Interrupting mid-thought leaves a thinking_tokens ping as the permanent
    // tail of the transcript. Without this gate the bar would claim the
    // session is still thinking for as long as the tab stayed open.
    const { container } = render(
      <ThinkingBar messages={[thinkingTokens(1300)]} isLive={false} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

vi.mock('@/contexts/MessageRenderingContext', async () => {
  const { createDefaultConfig } = await import('@/lib/messageRenderingConfig');
  return {
    useMessageRenderingConfig: () => ({ config: createDefaultConfig(), setConfig: () => {}, loaded: true }),
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

function userNode(text: string): Extract<JsonlNode, { kind: 'user' }> {
  return {
    kind: 'user',
    sessionId: 'sess-1',
    receivedAt: '2026-09-15T10:00:00Z',
    uuid: 'u-1',
    raw: {
      type: 'user',
      uuid: 'u-1',
      message: { role: 'user', content: [{ type: 'text', text }] },
    },
  } as unknown as Extract<JsonlNode, { kind: 'user' }>;
}

describe('StreamMessage slash-command envelope', () => {
  // Regression: the CLI persists custom/skill-backed commands message-first
  // with no <command-args>, which the old ordered regex could not match, so
  // the raw pseudo-XML was printed into the card.
  it('renders the message-first, args-less envelope as a command widget', () => {
    const node = userNode(
      '<command-message>timesheet-review</command-message>\n'
      + '<command-name>/timesheet-review</command-name>',
    );
    render(<StreamMessage message={node} streamMessages={[node]} tabId="tab-1" />);

    expect(screen.getByText('/timesheet-review')).toBeTruthy();
    expect(screen.queryByText(/<command-name>/)).toBeNull();
    expect(document.body.textContent).not.toContain('<command-message>');
  });

  it('still renders the name-first envelope with args', () => {
    const node = userNode(
      '<command-name>/usage</command-name>\n<command-message>usage</command-message>\n<command-args>--json</command-args>',
    );
    render(<StreamMessage message={node} streamMessages={[node]} tabId="tab-1" />);

    expect(screen.getByText('/usage')).toBeTruthy();
    expect(screen.getByText('--json')).toBeTruthy();
    expect(document.body.textContent).not.toContain('<command-args>');
  });

  // Session 5220766b: a pasted JSONL line carrying <local-command-stdout> made
  // the whole prompt render as that stdout alone.
  it('renders a prompt that quotes a stdout envelope in full', () => {
    const node = userNode('Look at this session.\n\n{"type":"system","content":"<local-command-stdout>You want every session</local-command-stdout>"}');
    render(<StreamMessage message={node} streamMessages={[node]} tabId="tab-1" />);
    expect(document.body.textContent).toContain('Look at this session.');
  });

  it('renders a prompt that quotes a command name as text, not a command widget', () => {
    const node = userNode('Why does this show twice? <command-name>/recap</command-name>');
    render(<StreamMessage message={node} streamMessages={[node]} tabId="tab-1" />);
    expect(document.body.textContent).toContain('Why does this show twice?');
  });

  // /recap's output is prose: rendered like an away summary, not in the
  // monospace block other command output uses.
  it('renders /recap output as an away summary in prose', () => {
    const recap = {
      kind: 'system', subtype: 'local_command', sessionId: 'sess-1', receivedAt: '2026-09-29T00:31:37Z',
      raw: { type: 'system', subtype: 'local_command', uuid: 'r-1',
        content: '<local-command-stdout>We fixed several display problems.</local-command-stdout>',
        commandRun: { command: 'recap', args: '' } },
    } as unknown as JsonlNode;
    render(<StreamMessage message={recap} streamMessages={[recap]} tabId="tab-1" />);
    const text = screen.getByText('We fixed several display problems.');
    expect(text.closest('pre')).toBeNull();
    expect(text.closest('.prose')).not.toBeNull();
    expect(document.body.textContent).not.toContain('<local-command-stdout>');
  });

  it('keeps other command output in the monospace block', () => {
    const usage = {
      kind: 'system', subtype: 'local_command', sessionId: 'sess-1', receivedAt: '2026-09-29T00:31:37Z',
      raw: { type: 'system', subtype: 'local_command', uuid: 'u-2',
        content: '<local-command-stdout>Session: 12%</local-command-stdout>',
        commandRun: { command: 'usage', args: '' } },
    } as unknown as JsonlNode;
    render(<StreamMessage message={usage} streamMessages={[usage]} tabId="tab-1" />);
    expect(screen.getByText(/Session: 12%/).closest('pre')).not.toBeNull();
  });
});

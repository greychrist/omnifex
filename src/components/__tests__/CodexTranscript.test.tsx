// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { AgentMessage } from '@/lib/api';

vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

import { CodexTranscript } from '@/components/codex/CodexTranscript';

afterEach(() => { cleanup(); });

function makeMessage(method: string, params: Record<string, unknown> = {}): AgentMessage {
  return {
    agent: 'codex',
    tabId: 'test-tab',
    receivedAt: '2026-05-27T00:00:00.000Z',
    sessionId: null,
    payload: { method, params },
  };
}

describe('CodexTranscript', () => {
  it('dispatches each known method to its dedicated stub component', () => {
    const messages: AgentMessage[] = [
      makeMessage('agent_message'),
      makeMessage('agent_reasoning'),
      makeMessage('item.exec_command'),
      makeMessage('item.apply_patch'),
      makeMessage('item.web_search'),
      makeMessage('item.mcp_tool_call'),
    ];

    render(<CodexTranscript messages={messages} tabId="test-tab" />);

    expect(document.querySelectorAll('[data-codex-item="agent_message"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-codex-item="agent_reasoning"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-codex-item="item.exec_command"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-codex-item="item.apply_patch"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-codex-item="item.web_search"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-codex-item="item.mcp_tool_call"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-codex-item="fallback"]')).toHaveLength(0);
  });

  it('skips task_started and task_complete (status-only signals)', () => {
    const messages: AgentMessage[] = [
      makeMessage('task_started'),
      makeMessage('agent_message'),
      makeMessage('task_complete'),
    ];

    render(<CodexTranscript messages={messages} tabId="test-tab" />);

    expect(document.querySelectorAll('[data-codex-item="agent_message"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-codex-item="fallback"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-codex-item]')).toHaveLength(1);
  });

  it('renders the fallback for unknown methods, surfacing the method name', () => {
    const messages: AgentMessage[] = [
      makeMessage('agent_message'),
      makeMessage('item.future_widget'),
    ];

    render(<CodexTranscript messages={messages} tabId="test-tab" />);

    expect(document.querySelectorAll('[data-codex-item="agent_message"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-codex-item="fallback"]')).toHaveLength(1);
    expect(screen.getByText('item.future_widget')).toBeTruthy();
    expect(screen.getByText(/Unknown Codex item:/)).toBeTruthy();
  });

  it('ignores messages whose payload is not a Codex notification envelope', () => {
    // The shared claude-output channel also carries Claude stream-json.
    const messages: AgentMessage[] = [
      { agent: 'codex', tabId: 't', receivedAt: '', sessionId: null, payload: { type: 'assistant' } },
      { agent: 'codex', tabId: 't', receivedAt: '', sessionId: null, payload: null },
      makeMessage('agent_message'),
    ];

    render(<CodexTranscript messages={messages} tabId="test-tab" />);

    expect(document.querySelectorAll('[data-codex-item]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-codex-item="agent_message"]')).toHaveLength(1);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { createDefaultConfig } from '@/lib/messageRenderingConfig';
import { MessageRenderingPreviewProvider } from '@/contexts/MessageRenderingContext';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';

vi.mock('@/hooks', () => ({ useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }) }));

import { InflightThinking } from '@/components/InflightThinking';

afterEach(() => { cleanup(); useClaudeSessionStore.getState().__resetForTests(); });

function renderWith(config = createDefaultConfig()) {
  return render(<MessageRenderingPreviewProvider config={config}><InflightThinking tabId="t1" /></MessageRenderingPreviewProvider>);
}

describe('InflightThinking — the classic formats\' live thought', () => {
  it('renders nothing until a thought streams', () => {
    const { container } = renderWith();
    expect(container).toBeEmptyDOMElement();
  });

  it('types the thought in, open, as the thinking card the formats already draw', () => {
    renderWith();
    act(() => { useClaudeSessionStore.getState().setInflightThinkingText('t1', 'I recall the 6-queens'); });
    expect(screen.getByText('I recall the 6-queens')).toBeInTheDocument();
    act(() => { useClaudeSessionStore.getState().setInflightThinkingText('t1', 'I recall the 6-queens problem'); });
    expect(screen.getByText('I recall the 6-queens problem')).toBeInTheDocument();
  });

  it('respects thinking set to Never in Appearance', () => {
    const config = createDefaultConfig();
    config.kinds['assistant.thinking'] = { visibility: 'never' };
    const { container } = renderWith(config);
    act(() => { useClaudeSessionStore.getState().setInflightThinkingText('t1', 'hidden'); });
    expect(container).toBeEmptyDOMElement();
  });
});

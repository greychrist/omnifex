// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import React from 'react';

// Capture the props ReactMarkdown is handed on each render. Prop *identity*
// is the thing under test: react-markdown rebuilds its nested Prism-highlighted
// DOM when `remarkPlugins` / `components` arrive as fresh references, so an
// inline array literal makes every streaming delta re-parse the whole turn.
const markdownProps: { remarkPlugins: unknown; components: unknown }[] = [];

// The bubble's only use of the hooks barrel is useTheme, which otherwise
// demands a ThemeProvider ancestor. The syntax theme it feeds is irrelevant
// here — what matters is that it stays constant, as it does in the app.
vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'dark' }),
}));

vi.mock('react-markdown', () => ({
  default: (props: { remarkPlugins: unknown; components: unknown; children: string }) => {
    markdownProps.push({
      remarkPlugins: props.remarkPlugins,
      components: props.components,
    });
    return React.createElement('div', { 'data-testid': 'md' }, props.children);
  },
}));

vi.mock('@/components/diagram/MermaidBlock', () => ({
  MermaidBlock: ({ streaming }: { streaming?: boolean }) =>
    React.createElement('div', { 'data-testid': 'mermaid', 'data-streaming': String(Boolean(streaming)) }),
}));

import { InflightAssistantBubble } from '../InflightAssistantBubble';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import { MessageRenderingPreviewProvider } from '@/contexts/MessageRenderingContext';
import { createDefaultConfig } from '@/lib/messageRenderingConfig';

function setInflight(tabId: string, text: string): void {
  act(() => {
    useClaudeSessionStore
      .getState()
      .setInflightAssistantText(tabId, `uuid-${text.length.toString()}`, text, null);
  });
}

beforeEach(() => {
  markdownProps.length = 0;
  useClaudeSessionStore.getState().__resetForTests();
});

afterEach(() => {
  cleanup();
});

describe('InflightAssistantBubble', () => {
  // The text is still arriving and may or may not be the final answer, so
  // it wears its own configurable chrome — "Live reply" — rather than a
  // hard-coded card that looks like any finished message.
  it('wears the Live reply chrome by default: dashed, amber, titled', () => {
    setInflight('t1', 'partial answer');
    const { container, getByText } = render(<InflightAssistantBubble tabId="t1" />);
    const card = container.querySelector('.group\\/card') as HTMLElement;
    expect(card.style.borderStyle).toBe('dashed');
    expect(getByText('Live reply')).toBeTruthy();
    const amber = render(
      <MessageRenderingPreviewProvider config={createDefaultConfig()}>
        <InflightAssistantBubble tabId="t1" />
      </MessageRenderingPreviewProvider>,
    );
    expect(amber.container.innerHTML).toContain('245, 158, 11');
  });

  it('follows the Live reply style the user set in Appearance', () => {
    setInflight('t1', 'partial answer');
    const config = createDefaultConfig();
    config.kinds = { ...config.kinds, 'assistant.text.live': { borderStyle: 'solid', headerLabel: 'Typing…' } };
    const { container, getByText } = render(
      <MessageRenderingPreviewProvider config={config}>
        <InflightAssistantBubble tabId="t1" />
      </MessageRenderingPreviewProvider>,
    );
    const card = container.querySelector('.group\\/card') as HTMLElement;
    expect(card.style.borderStyle).toBe('solid');
    expect(getByText('Typing…')).toBeTruthy();
  });

  it('is a regular message: it follows the configured alignment and presentation', () => {
    setInflight('t1', 'partial answer');
    const config = createDefaultConfig();
    config.kinds = { ...config.kinds, 'assistant.text.live': { alignment: 'narrow-center' } };
    const centered = render(
      <MessageRenderingPreviewProvider config={config}>
        <InflightAssistantBubble tabId="t1" />
      </MessageRenderingPreviewProvider>,
    );
    expect(centered.container.querySelector('[class*="justify-center"]')).not.toBeNull();
    cleanup();

    config.kinds = { ...config.kinds, 'assistant.text.live': { presentation: 'side-line' } };
    const sideLine = render(
      <MessageRenderingPreviewProvider config={config}>
        <InflightAssistantBubble tabId="t1" />
      </MessageRenderingPreviewProvider>,
    );
    expect(sideLine.container.querySelector('[data-frame-variant="side-line"]')).not.toBeNull();
  });

  it('hands mermaid fences the streaming flag, so a half-written diagram is not drawn', () => {
    setInflight('t1', 'x');
    render(<InflightAssistantBubble tabId="t1" />);
    const components = markdownProps[0].components as {
      code: (p: { className: string; children: string }) => React.ReactElement;
    };
    const { getByTestId } = render(components.code({ className: 'language-mermaid', children: 'flowchart LR' }));
    expect(getByTestId('mermaid').getAttribute('data-streaming')).toBe('true');
  });

  it('renders nothing while the in-flight slot is empty', () => {
    const { container } = render(<InflightAssistantBubble tabId="t1" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the buffered in-flight text', () => {
    setInflight('t1', 'hello world');
    const { getByTestId } = render(<InflightAssistantBubble tabId="t1" />);
    expect(getByTestId('md').textContent).toBe('hello world');
  });

  it('passes a stable remarkPlugins reference across streaming re-renders', () => {
    setInflight('t1', 'a');
    render(<InflightAssistantBubble tabId="t1" />);

    // Each delta grows the text and re-renders the bubble — the plugin list
    // must not be rebuilt, or react-markdown re-parses from scratch every time.
    setInflight('t1', 'ab');
    setInflight('t1', 'abc');

    expect(markdownProps.length).toBeGreaterThanOrEqual(3);
    const first = markdownProps[0];
    for (const props of markdownProps) {
      expect(props.remarkPlugins).toBe(first.remarkPlugins);
    }
  });

  it('passes a stable components reference across streaming re-renders', () => {
    setInflight('t1', 'a');
    render(<InflightAssistantBubble tabId="t1" />);
    setInflight('t1', 'ab');
    setInflight('t1', 'abc');

    const first = markdownProps[0];
    for (const props of markdownProps) {
      expect(props.components).toBe(first.components);
    }
  });
});

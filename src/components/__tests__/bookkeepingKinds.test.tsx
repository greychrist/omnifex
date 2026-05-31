// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';

// StreamMessage calls useTheme(); mock it so the component renders without a
// ThemeProvider. Everything else (MessageFrame, the rendering config, the
// registry) is left REAL so these tests prove the kinds render for real.
vi.mock('@/hooks', () => ({
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

import { MessageRenderingPreviewProvider } from '@/contexts/MessageRenderingContext';
import { createDefaultConfig } from '@/lib/messageRenderingConfig';
import { StreamMessage } from '@/components/StreamMessage';
import type { JsonlNode } from '@/types/jsonl';

afterEach(() => { cleanup(); });

function renderNode(node: JsonlNode) {
  return render(
    <MessageRenderingPreviewProvider config={createDefaultConfig()}>
      <StreamMessage message={node} streamMessages={[node]} />
    </MessageRenderingPreviewProvider>,
  );
}

describe('bookkeeping JSONL kinds render (were return null)', () => {
  it("renders a permission-mode change as 'Permission → <mode>'", () => {
    const node = { kind: 'permission-mode', raw: { type: 'permission-mode', permissionMode: 'acceptEdits' }, sessionId: 's' } as unknown as JsonlNode;
    renderNode(node);
    expect(screen.getByText(/Permission → acceptEdits/)).toBeInTheDocument();
  });

  it('renders an ai-title node with the title', () => {
    const node = { kind: 'ai-title', raw: { type: 'ai-title', aiTitle: 'Refactor auth' }, sessionId: 's' } as unknown as JsonlNode;
    renderNode(node);
    expect(screen.getByText(/Refactor auth/)).toBeInTheDocument();
  });

  it('renders a queue-operation node with the operation', () => {
    const node = { kind: 'queue-operation', raw: { type: 'queue-operation', operation: 'enqueue' }, sessionId: 's', receivedAt: '2026-05-31T00:00:00Z' } as unknown as JsonlNode;
    renderNode(node);
    expect(screen.getByText(/Background: enqueue/)).toBeInTheDocument();
  });

  it('renders a file-history-snapshot (no receivedAt) without throwing', () => {
    const node = { kind: 'file-history-snapshot', raw: { type: 'file-history-snapshot', snapshot: {} } } as unknown as JsonlNode;
    renderNode(node);
    expect(screen.getByText(/File snapshot/)).toBeInTheDocument();
  });

  it('renders a last-prompt bookmark', () => {
    const node = { kind: 'last-prompt', raw: { type: 'last-prompt', lastPrompt: 'hi', leafUuid: 'u' }, sessionId: 's' } as unknown as JsonlNode;
    renderNode(node);
    expect(screen.getByText(/Bookmarked prompt/)).toBeInTheDocument();
  });
});

describe('synthetic control-change markers render', () => {
  it("renders a control-change effort node as 'Effort → high'", () => {
    const node = { kind: 'control-change', control: 'effort', value: 'high', sessionId: 's', receivedAt: '2026-05-31T00:00:00Z' } as unknown as JsonlNode;
    renderNode(node);
    expect(screen.getByText(/Effort → high/)).toBeInTheDocument();
  });

  it("renders a control-change model node as 'Model → opus'", () => {
    const node = { kind: 'control-change', control: 'model', value: 'opus', sessionId: 's', receivedAt: '2026-05-31T00:00:00Z' } as unknown as JsonlNode;
    renderNode(node);
    expect(screen.getByText(/Model → opus/)).toBeInTheDocument();
  });

  it("renders a control-change permission node as 'Permission → plan'", () => {
    const node = { kind: 'control-change', control: 'permission', value: 'plan', sessionId: 's', receivedAt: '2026-05-31T00:00:00Z' } as unknown as JsonlNode;
    renderNode(node);
    expect(screen.getByText(/Permission → plan/)).toBeInTheDocument();
  });
});

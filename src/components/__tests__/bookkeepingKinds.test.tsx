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
      <StreamMessage tabId="tab-test" message={node} streamMessages={[node]} />
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

  // A rename is a deliberate act, so scrollback says who the session became
  // rather than just that a title record went by.
  it('renders a custom-title node as a rename', () => {
    const node = { kind: 'custom-title', raw: { type: 'custom-title', customTitle: 'Rate-limit spike' }, sessionId: 's' } as unknown as JsonlNode;
    renderNode(node);
    expect(screen.getByText(/Renamed .*Rate-limit spike/)).toBeInTheDocument();
  });

  // The CLI's input queue — prompts, task notifications, agent messages —
  // not background tasks, which the old "Background:" label implied.
  it('renders a queue-operation as an input-queue operation', () => {
    const node = { kind: 'queue-operation', raw: { type: 'queue-operation', operation: 'enqueue' }, sessionId: 's', receivedAt: '2026-05-31T00:00:00Z' } as unknown as JsonlNode;
    renderNode(node);
    expect(screen.getByText('Input queue: enqueue')).toBeInTheDocument();
  });

  it('says how long a dequeued input waited, when it waited', () => {
    const enq = { kind: 'queue-operation', raw: { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-28T15:00:00.000Z' }, sessionId: 's', receivedAt: '2026-09-28T15:00:00.000Z' } as unknown as JsonlNode;
    const deq = { kind: 'queue-operation', raw: { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-09-28T15:00:42.000Z' }, sessionId: 's', receivedAt: '2026-09-28T15:00:42.000Z' } as unknown as JsonlNode;
    render(
      <MessageRenderingPreviewProvider config={createDefaultConfig()}>
        <StreamMessage tabId="tab-test" message={deq} streamMessages={[enq, deq]} />
      </MessageRenderingPreviewProvider>,
    );
    expect(screen.getByText('Input queue: dequeue · waited 42.00s')).toBeInTheDocument();
  });

  it('leaves out a wait under a second — the input started at once', () => {
    const enq = { kind: 'queue-operation', raw: { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-28T15:00:00.000Z' }, sessionId: 's', receivedAt: '2026-09-28T15:00:00.000Z' } as unknown as JsonlNode;
    const deq = { kind: 'queue-operation', raw: { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-09-28T15:00:00.001Z' }, sessionId: 's', receivedAt: '2026-09-28T15:00:00.001Z' } as unknown as JsonlNode;
    render(
      <MessageRenderingPreviewProvider config={createDefaultConfig()}>
        <StreamMessage tabId="tab-test" message={deq} streamMessages={[enq, deq]} />
      </MessageRenderingPreviewProvider>,
    );
    expect(screen.getByText('Input queue: dequeue')).toBeInTheDocument();
  });

  it('says why an input was removed', () => {
    const node = { kind: 'queue-operation', raw: { type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn' }, sessionId: 's', receivedAt: '2026-05-31T00:00:00Z' } as unknown as JsonlNode;
    renderNode(node);
    expect(screen.getByText('Input queue: remove · absorbed mid-turn')).toBeInTheDocument();
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

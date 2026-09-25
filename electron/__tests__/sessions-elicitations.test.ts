import { describe, it, expect, vi } from 'vitest';
import { createSideChatStore } from '../services/sessions/side-chat';
import {
  createElicitationHandlers,
  respondToElicitation,
} from '../services/sessions/elicitations';
import type { SessionHandle } from '../services/sessions/types';
import type { AgentElicitationRequest } from '../services/agents/types';

/**
 * MCP elicitations: the CLI relays an MCP server's question as a
 * control_request and parks the session until the host answers. One dialog
 * at a time; the rest wait their turn, and a request the CLI withdraws
 * leaves the queue without an answer.
 */
function harness() {
  const respondElicitation = vi.fn(async () => {});
  const handle = {
    engine: { respondElicitation },
    projectPath: '/Users/test/omnifex',
    elicitationQueue: [],
    sideChat: createSideChatStore(),
  } as unknown as SessionHandle;
  const sendToRenderer = vi.fn();
  const showNotification = vi.fn();
  const handlers = createElicitationHandlers(handle, 'tab-1', sendToRenderer, {
    showNotification,
    incrementUnread: vi.fn(),
  });
  const shown = () =>
    sendToRenderer.mock.calls
      .filter(([channel]) => channel === 'elicitation-request:tab-1')
      .map(([, payload]) => payload as AgentElicitationRequest | null);
  return { handle, handlers, sendToRenderer, showNotification, respondElicitation, shown };
}

const req = (requestId: string, extra: Partial<AgentElicitationRequest> = {}): AgentElicitationRequest => ({
  requestId,
  serverName: 'github',
  message: `Question ${requestId}`,
  mode: 'form',
  ...extra,
});

describe('MCP elicitations', () => {
  it('shows the first request and notifies', () => {
    const { handlers, shown, showNotification } = harness();
    handlers.onRequest(req('e1'));
    expect(shown()).toEqual([req('e1')]);
    expect(showNotification).toHaveBeenCalledWith(
      'OmniFex — omnifex',
      'Question e1',
      false,
      { tabId: 'tab-1' },
      { subtitle: 'github needs your input' },
    );
  });

  it('queues a second request behind the one on screen', () => {
    const { handlers, shown } = harness();
    handlers.onRequest(req('e1'));
    handlers.onRequest(req('e2'));
    expect(shown()).toEqual([req('e1')]);
  });

  it('answers the head, then shows the next', async () => {
    const { handle, handlers, shown, respondElicitation, sendToRenderer } = harness();
    handlers.onRequest(req('e1'));
    handlers.onRequest(req('e2'));
    await respondToElicitation(handle, 'tab-1', sendToRenderer, 'accept', { repo: 'x' }, 'e1');
    expect(respondElicitation).toHaveBeenCalledWith('e1', 'accept', { repo: 'x' });
    expect(shown()).toEqual([req('e1'), req('e2')]);
  });

  it('clears the dialog once the last request is answered', async () => {
    const { handle, handlers, shown, sendToRenderer } = harness();
    handlers.onRequest(req('e1'));
    await respondToElicitation(handle, 'tab-1', sendToRenderer, 'decline', undefined, 'e1');
    expect(shown()).toEqual([req('e1'), null]);
  });

  // A dialog still on screen for a request the CLI already withdrew must not
  // answer the one queued behind it.
  it('ignores an answer addressed to a request that is no longer at the head', async () => {
    const { handle, handlers, respondElicitation, sendToRenderer } = harness();
    handlers.onRequest(req('e1'));
    handlers.onRequest(req('e2'));
    handlers.onCancel('e1');
    await respondToElicitation(handle, 'tab-1', sendToRenderer, 'accept', {}, 'e1');
    expect(respondElicitation).not.toHaveBeenCalled();
  });

  it('drops a withdrawn head and shows the next without answering it', () => {
    const { handlers, shown, respondElicitation } = harness();
    handlers.onRequest(req('e1'));
    handlers.onRequest(req('e2'));
    handlers.onCancel('e1');
    expect(shown()).toEqual([req('e1'), req('e2')]);
    expect(respondElicitation).not.toHaveBeenCalled();
  });

  it('drops a withdrawn queued request silently', () => {
    const { handle, handlers, shown } = harness();
    handlers.onRequest(req('e1'));
    handlers.onRequest(req('e2'));
    handlers.onCancel('e2');
    expect(shown()).toEqual([req('e1')]);
    expect(handle.elicitationQueue.map((r) => r.requestId)).toEqual(['e1']);
  });

  it('ignores a cancel for a request it never saw (a permission prompt, say)', () => {
    const { handlers, shown } = harness();
    handlers.onRequest(req('e1'));
    handlers.onCancel('perm-7');
    expect(shown()).toEqual([req('e1')]);
  });

  it('names the server by its display name when the CLI sends one', () => {
    const { handlers, showNotification } = harness();
    handlers.onRequest(req('e1', { displayName: 'GitHub' }));
    expect(showNotification.mock.calls[0][4]).toEqual({ subtitle: 'GitHub needs your input' });
  });
});

describe('toElicitationAction', () => {
  it('passes accept and decline, and turns anything else into cancel', async () => {
    const { toElicitationAction } = await import('../services/sessions/elicitations');
    expect(toElicitationAction('accept')).toBe('accept');
    expect(toElicitationAction('decline')).toBe('decline');
    expect(toElicitationAction('cancel')).toBe('cancel');
    expect(toElicitationAction('allow')).toBe('cancel');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import type { JsonlNode } from '@/types/jsonl';
import { useClaudeSessionStore, EMPTY_TAB_SESSION } from '../claudeSessionStore';

const TAB = 'tab-1';

beforeEach(() => {
  useClaudeSessionStore.getState().__resetForTests();
});

const userMsg = (): JsonlNode =>
  ({
    kind: 'user', userKind: 'prompt', sessionId: '', receivedAt: '',
    raw: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
  }) as unknown as JsonlNode;

const initMsg = (): JsonlNode =>
  ({
    kind: 'system', subtype: 'init', sessionId: '', receivedAt: '',
    raw: { type: 'system', subtype: 'init', session_id: 'sess-1' },
  }) as unknown as JsonlNode;

const assistantMsg = (text = 'ok'): JsonlNode =>
  ({
    kind: 'assistant', sessionId: '', receivedAt: '',
    raw: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }) as unknown as JsonlNode;

describe('claudeSessionStore', () => {
  it('returns EMPTY_TAB_SESSION for an unknown tab via selectTab', () => {
    const slice = useClaudeSessionStore.getState().selectTab('does-not-exist');
    expect(slice).toEqual(EMPTY_TAB_SESSION);
  });

  it('patchTab merges fields and creates a tab on first write', () => {
    useClaudeSessionStore.getState().patchTab(TAB, { contextUsage: { used: 1 } as never });
    expect((useClaudeSessionStore.getState().selectTab(TAB).contextUsage as { used?: number })?.used).toBe(1);
    useClaudeSessionStore
      .getState()
      .patchTab(TAB, { claudeSessionId: 'sess-1' });
    const slice = useClaudeSessionStore.getState().selectTab(TAB);
    expect((slice.contextUsage as { used?: number })?.used).toBe(1);
    expect(slice.claudeSessionId).toBe('sess-1');
  });

  it('setMessages accepts a value or an updater function', () => {
    const a = assistantMsg('a');
    const b = assistantMsg('b');
    useClaudeSessionStore.getState().setMessages(TAB, [a]);
    expect(useClaudeSessionStore.getState().selectTab(TAB).messages).toEqual([a]);
    useClaudeSessionStore.getState().setMessages(TAB, (prev) => [...prev, b]);
    expect(useClaudeSessionStore.getState().selectTab(TAB).messages).toEqual([a, b]);
  });

  it('appendMessage pushes to the end', () => {
    const a = assistantMsg('a');
    const b = assistantMsg('b');
    const store = useClaudeSessionStore.getState();
    store.appendMessage(TAB, a);
    store.appendMessage(TAB, b);
    expect(store.selectTab(TAB).messages).toEqual([a, b]);
  });

  // The optimistic prompt echo (no uuid) is a placeholder for the CLI's own
  // record of the same prompt. See src/lib/promptReconciliation.ts.
  describe('appendOrReconcilePrompt', () => {
    const cliPrompt = (text: string, uuid: string): JsonlNode =>
      ({
        kind: 'user', userKind: 'prompt', sessionId: 'sess-1', receivedAt: '',
        raw: {
          type: 'user', uuid,
          message: { role: 'user', content: [{ type: 'text', text }] },
        },
      }) as unknown as JsonlNode;

    it('replaces the pending echo instead of appending a second copy', () => {
      const echo = userMsg();
      const record = cliPrompt('hi', 'u-1');
      const store = useClaudeSessionStore.getState();
      store.appendMessage(TAB, echo);
      store.appendOrReconcilePrompt(TAB, record);
      expect(store.selectTab(TAB).messages).toEqual([record]);
    });

    it('appends when no echo matches', () => {
      const a = assistantMsg('a');
      const record = cliPrompt('unrelated', 'u-1');
      const store = useClaudeSessionStore.getState();
      store.appendMessage(TAB, a);
      store.appendOrReconcilePrompt(TAB, record);
      expect(store.selectTab(TAB).messages).toEqual([a, record]);
    });

    it('appends a non-prompt node untouched', () => {
      const echo = userMsg();
      const a = assistantMsg('a');
      const store = useClaudeSessionStore.getState();
      store.appendMessage(TAB, echo);
      store.appendOrReconcilePrompt(TAB, a);
      expect(store.selectTab(TAB).messages).toEqual([echo, a]);
    });
  });

  it('insertMessageBeforeFirstUser splices in before the first user message', () => {
    const init = initMsg();
    const a = assistantMsg('hello');
    const u = userMsg();
    const store = useClaudeSessionStore.getState();
    store.setMessages(TAB, [a, u]);
    store.insertMessageBeforeFirstUser(TAB, init);
    expect(store.selectTab(TAB).messages).toEqual([a, init, u]);
  });

  it('insertMessageBeforeFirstUser appends when there is no user message yet', () => {
    const init = initMsg();
    const a = assistantMsg('hello');
    const store = useClaudeSessionStore.getState();
    store.setMessages(TAB, [a]);
    store.insertMessageBeforeFirstUser(TAB, init);
    expect(store.selectTab(TAB).messages).toEqual([a, init]);
  });

  it('resetTab clears all per-tab state', () => {
    const store = useClaudeSessionStore.getState();
    store.patchTab(TAB, { claudeSessionId: 'x' });
    store.appendMessage(TAB, assistantMsg());
    store.resetTab(TAB);
    expect(store.selectTab(TAB)).toEqual(EMPTY_TAB_SESSION);
  });

  it('per-tab isolation: writing to one tab does not affect another', () => {
    const store = useClaudeSessionStore.getState();
    store.patchTab('tab-a', { claudeSessionId: 'a' });
    store.patchTab('tab-b', { claudeSessionId: 'b' });
    expect(store.selectTab('tab-a').claudeSessionId).toBe('a');
    expect(store.selectTab('tab-b').claudeSessionId).toBe('b');
  });

  it('setInflightAssistantText populates the inflight slot and nothing else', () => {
    const store = useClaudeSessionStore.getState();
    store.patchTab(TAB, { claudeSessionId: 'x' });
    store.setInflightAssistantText(TAB, 'msg-uuid-1', 'Hello world', null);
    const slice = store.selectTab(TAB);
    expect(slice.inflightAssistant).toEqual({
      uuid: 'msg-uuid-1',
      text: 'Hello world',
      parentToolUseId: null,
    });
    // The turn is the session's axis (useSessionLifecycle), not a slot here:
    // a streamed partial delta cannot end it, so the per-tab busy indicator
    // cannot clear mid-turn — the 0.4.17 partial-messages bug.
    expect(slice.claudeSessionId).toBe('x');
    expect('isLoading' in slice).toBe(false);
  });

  it('setInflightAssistantText replaces the slot when re-called with new uuid/text', () => {
    const store = useClaudeSessionStore.getState();
    store.setInflightAssistantText(TAB, 'msg-uuid-1', 'first', null);
    store.setInflightAssistantText(TAB, 'msg-uuid-2', 'second', 'parent-tu-id');
    expect(store.selectTab(TAB).inflightAssistant).toEqual({
      uuid: 'msg-uuid-2',
      text: 'second',
      parentToolUseId: 'parent-tu-id',
    });
  });

  it('clearInflightAssistant sets the slot to null', () => {
    const store = useClaudeSessionStore.getState();
    store.setInflightAssistantText(TAB, 'msg-uuid-1', 'Hello', null);
    store.clearInflightAssistant(TAB);
    expect(store.selectTab(TAB).inflightAssistant).toBeNull();
  });

  it('inflight slot is per-tab — setting one does not leak to another', () => {
    const store = useClaudeSessionStore.getState();
    store.setInflightAssistantText('tab-A', 'uuid-A', 'A text', null);
    store.setInflightAssistantText('tab-B', 'uuid-B', 'B text', null);
    expect(store.selectTab('tab-A').inflightAssistant?.text).toBe('A text');
    expect(store.selectTab('tab-B').inflightAssistant?.text).toBe('B text');
  });

  it('EMPTY_TAB_SESSION includes inflightAssistant: null', () => {
    expect(EMPTY_TAB_SESSION.inflightAssistant).toBeNull();
  });
});

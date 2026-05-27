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
    useClaudeSessionStore.getState().patchTab(TAB, { isLoading: true });
    expect(useClaudeSessionStore.getState().selectTab(TAB).isLoading).toBe(true);
    useClaudeSessionStore
      .getState()
      .patchTab(TAB, { claudeSessionId: 'sess-1' });
    const slice = useClaudeSessionStore.getState().selectTab(TAB);
    expect(slice.isLoading).toBe(true);
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
    store.patchTab(TAB, { isLoading: true, claudeSessionId: 'x' });
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

  it('setInflightAssistantText populates the inflight slot without touching isLoading', () => {
    const store = useClaudeSessionStore.getState();
    store.patchTab(TAB, { isLoading: true });
    store.setInflightAssistantText(TAB, 'msg-uuid-1', 'Hello world', null);
    const slice = store.selectTab(TAB);
    expect(slice.inflightAssistant).toEqual({
      uuid: 'msg-uuid-1',
      text: 'Hello world',
      parentToolUseId: null,
    });
    // isLoading represents the parent-turn lifecycle (true between prompt
    // send and the SDK's result message). Streaming a partial text delta
    // does NOT end the turn — the in-chat typing-dots spinner is
    // suppressed independently via hasInflightAssistant in
    // ClaudeCodeSession.tsx, so this action must not touch isLoading or
    // the per-tab busy indicator (mainTurnInFlight in usePublishTabStatus)
    // clears prematurely and the tab spinner disappears mid-turn.
    expect(slice.isLoading).toBe(true);
  });

  it('setInflightAssistantText preserves isLoading when it was already false', () => {
    const store = useClaudeSessionStore.getState();
    // No prior patchTab — isLoading defaults to false in EMPTY_TAB_SESSION.
    store.setInflightAssistantText(TAB, 'msg-uuid-1', 'Hello', null);
    expect(store.selectTab(TAB).isLoading).toBe(false);
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

import { describe, it, expect, beforeEach } from 'vitest';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import { useClaudeSessionStore, EMPTY_TAB_SESSION } from '../claudeSessionStore';

const TAB = 'tab-1';

beforeEach(() => {
  useClaudeSessionStore.getState().__resetForTests();
});

const userMsg = (): ClaudeStreamMessage =>
  ({
    type: 'user',
    message: { content: [{ type: 'text', text: 'hi' }] },
  } as unknown as ClaudeStreamMessage);

const initMsg = (): ClaudeStreamMessage =>
  ({ type: 'system', subtype: 'init', session_id: 'sess-1' } as ClaudeStreamMessage);

const assistantMsg = (text = 'ok'): ClaudeStreamMessage =>
  ({ type: 'assistant', message: { content: [{ type: 'text', text }] } } as unknown as ClaudeStreamMessage);

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
});

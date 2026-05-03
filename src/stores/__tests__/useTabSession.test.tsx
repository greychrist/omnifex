// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import {
  useClaudeSessionStore,
  useTabSession,
  EMPTY_TAB_SESSION,
} from '../claudeSessionStore';

const TAB = 'tab-X';

beforeEach(() => {
  useClaudeSessionStore.getState().__resetForTests();
});

afterEach(() => cleanup());

const assistantMsg = (text = 'ok'): ClaudeStreamMessage =>
  ({ type: 'assistant', message: { content: [{ type: 'text', text }] } } as unknown as ClaudeStreamMessage);

const userMsg = (): ClaudeStreamMessage =>
  ({ type: 'user', message: { content: [{ type: 'text', text: 'u' }] } } as unknown as ClaudeStreamMessage);

const initMsg = (): ClaudeStreamMessage =>
  ({ type: 'system', subtype: 'init', session_id: 'sess-1' } as ClaudeStreamMessage);

function HookHarness({ tabId, capture }: { tabId: string; capture: (s: ReturnType<typeof useTabSession>) => void }) {
  const slice = useTabSession(tabId);
  capture(slice);
  return null;
}

describe('useTabSession', () => {
  it('returns the empty slice for an unknown tab', () => {
    let captured: ReturnType<typeof useTabSession> | null = null;
    render(<HookHarness tabId={TAB} capture={(s) => { captured = s; }} />);
    expect(captured).not.toBeNull();
    expect(captured!.messages).toEqual(EMPTY_TAB_SESSION.messages);
    expect(captured!.claudeSessionId).toBeNull();
    expect(captured!.isLoading).toBe(false);
  });

  it('setMessages with a value writes through to the store', () => {
    let captured: ReturnType<typeof useTabSession> | null = null;
    render(<HookHarness tabId={TAB} capture={(s) => { captured = s; }} />);
    const a = assistantMsg('a');
    act(() => captured!.setMessages([a]));
    expect(useClaudeSessionStore.getState().selectTab(TAB).messages).toEqual([a]);
  });

  it('setMessages with a function uses the previous value', () => {
    let captured: ReturnType<typeof useTabSession> | null = null;
    render(<HookHarness tabId={TAB} capture={(s) => { captured = s; }} />);
    const a = assistantMsg('a');
    const b = assistantMsg('b');
    act(() => captured!.setMessages([a]));
    act(() => captured!.setMessages((prev) => [...prev, b]));
    expect(useClaudeSessionStore.getState().selectTab(TAB).messages).toEqual([a, b]);
  });

  it('setClaudeSessionId, setExtractedSessionInfo, setSdkAccountInfo write through', () => {
    let captured: ReturnType<typeof useTabSession> | null = null;
    render(<HookHarness tabId={TAB} capture={(s) => { captured = s; }} />);
    act(() => captured!.setClaudeSessionId('sess-7'));
    act(() => captured!.setExtractedSessionInfo({ sessionId: 'x', projectId: 'p' }));
    act(() => captured!.setSdkAccountInfo({ email: 'a@b.c' } as any));
    const s = useClaudeSessionStore.getState().selectTab(TAB);
    expect(s.claudeSessionId).toBe('sess-7');
    expect(s.extractedSessionInfo).toEqual({ sessionId: 'x', projectId: 'p' });
    expect((s.sdkAccountInfo as any)?.email).toBe('a@b.c');
  });

  it('setContextUsage, setSupportedModels, setIsLoading write through', () => {
    let captured: ReturnType<typeof useTabSession> | null = null;
    render(<HookHarness tabId={TAB} capture={(s) => { captured = s; }} />);
    act(() => captured!.setContextUsage({ used: 1, total: 2 } as any));
    act(() => captured!.setSupportedModels([{ id: 'opus' }] as any));
    act(() => captured!.setIsLoading(true));
    const s = useClaudeSessionStore.getState().selectTab(TAB);
    expect((s.contextUsage as any)?.used).toBe(1);
    expect(s.supportedModels.length).toBe(1);
    expect(s.isLoading).toBe(true);
  });

  it('setIsLoading with a function gets the previous value', () => {
    let captured: ReturnType<typeof useTabSession> | null = null;
    render(<HookHarness tabId={TAB} capture={(s) => { captured = s; }} />);
    act(() => captured!.setIsLoading(true));
    act(() => captured!.setIsLoading((prev) => !prev));
    expect(useClaudeSessionStore.getState().selectTab(TAB).isLoading).toBe(false);
  });

  it('appendMessage adds to the tab', () => {
    let captured: ReturnType<typeof useTabSession> | null = null;
    render(<HookHarness tabId={TAB} capture={(s) => { captured = s; }} />);
    const a = assistantMsg('a');
    act(() => captured!.appendMessage(a));
    expect(useClaudeSessionStore.getState().selectTab(TAB).messages).toEqual([a]);
  });

  it('insertMessageBeforeFirstUser splices in before the first user', () => {
    let captured: ReturnType<typeof useTabSession> | null = null;
    render(<HookHarness tabId={TAB} capture={(s) => { captured = s; }} />);
    const a = assistantMsg('a');
    const u = userMsg();
    act(() => captured!.setMessages([a, u]));
    act(() => captured!.insertMessageBeforeFirstUser(initMsg()));
    const msgs = useClaudeSessionStore.getState().selectTab(TAB).messages;
    expect(msgs.length).toBe(3);
    expect(msgs[1]!.type).toBe('system');
  });

  it('resetTab clears the slice', () => {
    let captured: ReturnType<typeof useTabSession> | null = null;
    render(<HookHarness tabId={TAB} capture={(s) => { captured = s; }} />);
    act(() => captured!.setIsLoading(true));
    act(() => captured!.setClaudeSessionId('s1'));
    act(() => captured!.resetTab());
    const s = useClaudeSessionStore.getState().selectTab(TAB);
    expect(s).toEqual(EMPTY_TAB_SESSION);
  });
});

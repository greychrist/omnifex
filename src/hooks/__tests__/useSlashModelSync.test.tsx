// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { JsonlNode } from '@/types/jsonl';
import { useSlashModelSync } from '../useSlashModelSync';

afterEach(cleanup);

const slash = (model: string, uuid: string, saved = false): JsonlNode => ({
  kind: 'user', userKind: 'prompt', sessionId: 's1', receivedAt: 't',
  raw: { type: 'user', uuid, message: { role: 'user', content: `<local-command-stdout>Set model to \`x (${model})\`${saved ? ' and saved as your default for new sessions' : ''}</local-command-stdout>` } } as never,
});
const assistant = (model: string, uuid: string): JsonlNode => ({
  kind: 'assistant', sessionId: 's1', receivedAt: 't',
  raw: { type: 'assistant', uuid, message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } },
} as never);

function setup(initial: JsonlNode[]) {
  const onModel = vi.fn();
  const onSavedAsDefault = vi.fn();
  const hook = renderHook(({ messages }) => { useSlashModelSync({ messages, onModel, onSavedAsDefault }); }, { initialProps: { messages: initial } });
  return { ...hook, onModel, onSavedAsDefault };
}

describe('useSlashModelSync', () => {
  it('reports a /model result that arrives while the session runs', () => {
    const { rerender, onModel } = setup([assistant('claude-opus-5-5', 'a1')]);
    expect(onModel).not.toHaveBeenCalled();
    rerender({ messages: [assistant('claude-opus-5-5', 'a1'), slash('claude-fable-5-1', 'u1')] });
    expect(onModel).toHaveBeenCalledTimes(1);
    expect(onModel).toHaveBeenCalledWith('claude-fable-5-1');
    rerender({ messages: [assistant('claude-opus-5-5', 'a1'), slash('claude-fable-5-1', 'u1')] });
    expect(onModel).toHaveBeenCalledTimes(1);
  });

  it('ignores a /model result a later turn has superseded', () => {
    const { rerender, onModel } = setup([]);
    rerender({ messages: [slash('claude-fable-5-1', 'u1'), assistant('claude-opus-5-5', 'a1')] });
    expect(onModel).not.toHaveBeenCalled();
  });

  it('reports a trailing /model result in replayed history once', () => {
    const { rerender, onModel } = setup([]);
    rerender({ messages: [assistant('claude-opus-5-5', 'a1'), slash('claude-fable-5-1', 'u1')] });
    expect(onModel).toHaveBeenCalledWith('claude-fable-5-1');
    rerender({ messages: [assistant('claude-opus-5-5', 'a1'), slash('claude-fable-5-1', 'u1')] });
    expect(onModel).toHaveBeenCalledTimes(1);
  });

  it('says when the switch was also saved as the account default', () => {
    const { rerender, onSavedAsDefault } = setup([]);
    rerender({ messages: [slash('claude-fable-5-1', 'u1', true)] });
    expect(onSavedAsDefault).toHaveBeenCalledTimes(1);
    rerender({ messages: [slash('claude-fable-5-1', 'u1', true), slash('claude-opus-5-5', 'u2')] });
    expect(onSavedAsDefault).toHaveBeenCalledTimes(1);
  });
});

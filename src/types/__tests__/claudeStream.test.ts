import { describe, it, expect } from 'vitest';
import type { ClaudeStreamMessage } from '../claudeStream';
import {
  getMessageContent,
  isAssistantMessage,
  isResultMessage,
  isUserMessage,
} from '../claudeStream';

// Test factories. The cast widens through `unknown` because the real
// SDKAssistantMessage / SDKUserMessage / SDKResultMessage / SDKSystemMessage
// types require `uuid`, `session_id`, etc., which the runtime guards never
// depend on — these helpers only branch on `type` / `subtype`.
const make = <T extends ClaudeStreamMessage['type']>(
  partial: Record<string, unknown> & { type: T },
): ClaudeStreamMessage => partial as unknown as ClaudeStreamMessage;

describe('ClaudeStreamMessage guards', () => {
  describe('isAssistantMessage', () => {
    it('narrows on type === "assistant"', () => {
      const msg = make({ type: 'assistant', message: { content: [] } });
      expect(isAssistantMessage(msg)).toBe(true);
    });

    it('rejects every other variant', () => {
      expect(isAssistantMessage(make({ type: 'user', message: {} }))).toBe(false);
      expect(isAssistantMessage(make({ type: 'result', subtype: 'success' }))).toBe(false);
      expect(isAssistantMessage(make({ type: 'system', subtype: 'init' }))).toBe(false);
      expect(isAssistantMessage(make({ type: 'permission_request', request_id: 'r' }))).toBe(false);
      expect(isAssistantMessage(make({ type: 'summary', leafUuid: 'l', summary: 's' }))).toBe(false);
    });
  });

  describe('isUserMessage', () => {
    it('narrows live user messages and JSONL-replay user messages identically', () => {
      // Both SDKUserMessage and SDKUserMessageReplay carry type: 'user'.
      const live = make({ type: 'user', message: { content: 'hi' } });
      const replay = make({ type: 'user', message: { content: 'hi' }, isReplay: true });
      expect(isUserMessage(live)).toBe(true);
      expect(isUserMessage(replay)).toBe(true);
    });

    it('rejects non-user variants', () => {
      expect(isUserMessage(make({ type: 'assistant', message: { content: [] } }))).toBe(false);
      expect(isUserMessage(make({ type: 'result', subtype: 'success' }))).toBe(false);
    });
  });

  describe('isResultMessage', () => {
    it('narrows on type === "result" for both success and error subtypes', () => {
      expect(isResultMessage(make({ type: 'result', subtype: 'success' }))).toBe(true);
      expect(isResultMessage(make({ type: 'result', subtype: 'error_during_execution' }))).toBe(true);
    });

    it('rejects non-result variants', () => {
      expect(isResultMessage(make({ type: 'assistant', message: { content: [] } }))).toBe(false);
      expect(isResultMessage(make({ type: 'system', subtype: 'notification' }))).toBe(false);
    });
  });
});

describe('getMessageContent', () => {
  it('returns the wrapped BetaMessage content for assistant messages', () => {
    const blocks = [{ type: 'text', text: 'hi' }];
    const msg = make({ type: 'assistant', message: { content: blocks } });
    expect(getMessageContent(msg)).toBe(blocks);
  });

  it('returns the MessageParam content for user messages (string form)', () => {
    const msg = make({ type: 'user', message: { content: 'hello' } });
    expect(getMessageContent(msg)).toBe('hello');
  });

  it('returns the MessageParam content for user messages (array form)', () => {
    const blocks = [{ type: 'text', text: 'tool result' }];
    const msg = make({ type: 'user', message: { content: blocks } });
    expect(getMessageContent(msg)).toBe(blocks);
  });

  it('returns undefined for non-message-carrying variants', () => {
    expect(getMessageContent(make({ type: 'result', subtype: 'success' }))).toBeUndefined();
    expect(getMessageContent(make({ type: 'system', subtype: 'init' }))).toBeUndefined();
    expect(getMessageContent(make({ type: 'permission_request', request_id: 'r' }))).toBeUndefined();
    expect(getMessageContent(make({ type: 'summary', leafUuid: 'l', summary: 's' }))).toBeUndefined();
  });

  it('tolerates user messages with no inner message (defensive)', () => {
    const msg = make({ type: 'user' });
    expect(getMessageContent(msg)).toBeUndefined();
  });
});

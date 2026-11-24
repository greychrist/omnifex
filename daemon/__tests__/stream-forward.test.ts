// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  JSONL_CARRIED_TYPES,
  JSONL_CARRIED_SYSTEM_SUBTYPES,
  shouldForwardStreamMessage,
} from '../services/sessions/stream-forward';

describe('shouldForwardStreamMessage', () => {
  describe('drops what the JSONL already carries', () => {
    it('drops committed transcript rows', () => {
      expect(shouldForwardStreamMessage({ type: 'assistant', message: {} })).toBe(false);
      expect(shouldForwardStreamMessage({ type: 'user', message: {} })).toBe(false);
      expect(shouldForwardStreamMessage({ type: 'attachment' })).toBe(false);
    });

    it('drops the bookkeeping rows the CLI persists', () => {
      // CLI 2.1.273: rename_session writes `custom-title` to disk.
      for (const type of ['last-prompt', 'queue-operation', 'atis-latch', 'mode', 'ai-title', 'custom-title']) {
        expect(shouldForwardStreamMessage({ type })).toBe(false);
      }
    });

    it('drops system subtypes the CLI writes to disk', () => {
      // compact_boundary: the renderer gets its copy from the tail, so forwarding
      // would double it.
      for (const subtype of [
        'stop_hook_summary',
        'compact_boundary',
        'api_error',
        'local_command',
        'turn_duration',
        'away_summary',
        'model_refusal_fallback',
      ]) {
        expect(shouldForwardStreamMessage({ type: 'system', subtype })).toBe(false);
      }
    });
  });

  describe('forwards what only the stream carries', () => {
    // --forward-subagent-text frames go to the agent's own agent-<id>.jsonl, never
    // the session JSONL.
    it('forwards subagent assistant frames, which no session JSONL carries', () => {
      expect(shouldForwardStreamMessage({
        type: 'assistant', parent_tool_use_id: 'toolu_A',
        message: { content: [{ type: 'tool_use', name: 'mcp__omnifex__progress', input: {} }] },
      })).toBe(true);
    });

    it('still drops a main-session assistant, whose JSONL copy the tail delivers', () => {
      expect(shouldForwardStreamMessage({ type: 'assistant', parent_tool_use_id: null, message: { content: [] } })).toBe(false);
    });

    it('still drops forwarded user frames — nothing reads them, and a subagent tool_result would render as an orphan', () => {
      expect(shouldForwardStreamMessage({ type: 'user', parent_tool_use_id: 'toolu_A', message: { content: [] } })).toBe(false);
    });

    it('forwards partial token deltas', () => {
      expect(
        shouldForwardStreamMessage({ type: 'stream_event', event: { type: 'message_delta' } }),
      ).toBe(true);
    });

    it('forwards turn results', () => {
      // The CLI never writes a top-level `result` line to disk.
      expect(shouldForwardStreamMessage({ type: 'result', subtype: 'success' })).toBe(true);
    });

    it('forwards permission prompts', () => {
      // The CLI writes no permission_request records to disk.
      expect(shouldForwardStreamMessage({ type: 'permission_request' })).toBe(true);
    });

    it('forwards rate limit events', () => {
      expect(shouldForwardStreamMessage({ type: 'rate_limit_event' })).toBe(true);
    });

    it('forwards system subtypes absent from disk', () => {
      for (const subtype of [
        'init',
        'hook_started',
        'hook_progress',
        'hook_response',
        'user_prompt_submit',
        'task_started',
        'task_notification',
        'thinking_tokens',
        'permission_denied',
      ]) {
        expect(shouldForwardStreamMessage({ type: 'system', subtype })).toBe(true);
      }
    });
  });

  describe('fails toward the visible bug', () => {
    it('forwards an unrecognised system subtype', () => {
      expect(shouldForwardStreamMessage({ type: 'system', subtype: 'subtype_from_the_future' })).toBe(
        true,
      );
    });

    it('forwards an unrecognised top-level type', () => {
      expect(shouldForwardStreamMessage({ type: 'type_from_the_future' })).toBe(true);
    });
  });

  describe('deny-list integrity', () => {
    it('never lists a type in both the type and subtype denial sets', () => {
      for (const subtype of JSONL_CARRIED_SYSTEM_SUBTYPES) {
        expect(JSONL_CARRIED_TYPES.has(subtype)).toBe(false);
      }
    });

    it('does not deny `system` wholesale', () => {
      expect(JSONL_CARRIED_TYPES.has('system')).toBe(false);
    });

    it('tolerates a malformed payload without forwarding a transcript row', () => {
      expect(shouldForwardStreamMessage(null)).toBe(true);
      expect(shouldForwardStreamMessage(undefined)).toBe(true);
      expect(shouldForwardStreamMessage('nonsense')).toBe(true);
    });
  });
});

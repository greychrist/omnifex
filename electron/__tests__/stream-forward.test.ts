// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  JSONL_CARRIED_TYPES,
  JSONL_CARRIED_SYSTEM_SUBTYPES,
  shouldForwardStreamMessage,
} from '../services/sessions/stream-forward';

/**
 * The transcript inversion makes the CLI's own JSONL the sole source of
 * committed transcript rows. stream-json keeps only what the JSONL never
 * carries — partial token deltas, permission prompts, `result`, and the
 * handful of `system` subtypes the CLI never writes to disk.
 *
 * Both sets below were derived empirically, not guessed: a census of every
 * record in all 890 session transcripts under the personal config dir.
 * Anything that showed up on disk is a row the tail will deliver, so the
 * stream's copy of it must be dropped or the renderer shows it twice.
 *
 * The predicate is a DENY-list on purpose. An unrecognised shape forwards.
 * A new stream-only subtype that silently vanished from the UI is exactly
 * the failure this change exists to kill; a double-rendered row is loud and
 * obvious by comparison. Fail toward the visible bug.
 */
describe('shouldForwardStreamMessage', () => {
  describe('drops what the JSONL already carries', () => {
    it('drops committed transcript rows', () => {
      expect(shouldForwardStreamMessage({ type: 'assistant', message: {} })).toBe(false);
      expect(shouldForwardStreamMessage({ type: 'user', message: {} })).toBe(false);
      expect(shouldForwardStreamMessage({ type: 'attachment' })).toBe(false);
    });

    it('drops the bookkeeping rows the CLI persists', () => {
      // `custom-title` is the newest member and the only one not from the
      // original census — no transcript had one until the app could rename a
      // session. Verified against CLI 2.1.273: a `rename_session` control
      // request writes the record to disk, so the tail delivers it and the
      // stream's copy would be a second one.
      for (const type of ['last-prompt', 'queue-operation', 'atis-latch', 'mode', 'ai-title', 'custom-title']) {
        expect(shouldForwardStreamMessage({ type })).toBe(false);
      }
    });

    it('drops system subtypes the CLI writes to disk', () => {
      // Every subtype the census found on disk. compact_boundary is the
      // notable one: main still classifies it for the compact hint, but the
      // renderer gets its copy from the tail, so forwarding would double it.
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
    it('forwards partial token deltas', () => {
      expect(
        shouldForwardStreamMessage({ type: 'stream_event', event: { type: 'message_delta' } }),
      ).toBe(true);
    });

    it('forwards turn results', () => {
      // The CLI never writes a top-level `result` line; tui-jsonl.ts has to
      // synthesise one from a terminal stop_reason precisely because of this.
      expect(shouldForwardStreamMessage({ type: 'result', subtype: 'success' })).toBe(true);
    });

    it('forwards permission prompts', () => {
      // Zero permission_request records exist on disk. Dropping these would
      // make every permission prompt in rich mode disappear.
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
      // A subtype the CLI adds after this was written. Forwarding may double
      // a row; dropping would hide it with nothing to notice. Prefer loud.
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
      // `system` carries both on-disk and stream-only subtypes, so the
      // decision has to be made per subtype, never on the type alone.
      expect(JSONL_CARRIED_TYPES.has('system')).toBe(false);
    });

    it('tolerates a malformed payload without forwarding a transcript row', () => {
      expect(shouldForwardStreamMessage(null)).toBe(true);
      expect(shouldForwardStreamMessage(undefined)).toBe(true);
      expect(shouldForwardStreamMessage('nonsense')).toBe(true);
    });
  });
});

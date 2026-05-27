import { describe, it, expect } from 'vitest';
import { classifyRuntimeEvent } from '../services/sessions/events';

describe('classifyRuntimeEvent', () => {
  it('classifies system:init and extracts session id', () => {
    const event = classifyRuntimeEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-123',
    });
    expect(event.kind).toBe('init');
    if (event.kind === 'init') {
      expect(event.sessionId).toBe('sess-123');
    }
  });

  it('classifies system:init with no session id as init with null sessionId', () => {
    const event = classifyRuntimeEvent({ type: 'system', subtype: 'init' });
    expect(event.kind).toBe('init');
    if (event.kind === 'init') {
      expect(event.sessionId).toBeNull();
    }
  });

  it('classifies result message and surfaces is_error + body', () => {
    const event = classifyRuntimeEvent({
      type: 'result',
      subtype: 'success',
      result: 'all good',
    });
    expect(event.kind).toBe('result');
    if (event.kind === 'result') {
      expect(event.isError).toBe(false);
      expect(event.body).toBe('all good');
    }
  });

  it('classifies result with is_error: true as error', () => {
    const event = classifyRuntimeEvent({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'boom',
    });
    expect(event.kind).toBe('result');
    if (event.kind === 'result') {
      expect(event.isError).toBe(true);
      expect(event.body).toBe('boom');
    }
  });

  it('classifies result with subtype "error" as error even without is_error flag', () => {
    const event = classifyRuntimeEvent({
      type: 'result',
      subtype: 'error',
      error: 'something broke',
    });
    expect(event.kind).toBe('result');
    if (event.kind === 'result') {
      expect(event.isError).toBe(true);
      expect(event.body).toBe('something broke');
    }
  });

  it('surfaces SDK result error subtypes in the body for diagnostic clarity', () => {
    // The SDK distinguishes error_max_turns / error_during_execution /
    // error_max_budget_usd / error_max_structured_output_retries. Notifications
    // should reflect the specific cause rather than collapsing them all to a
    // generic "Task failed" — `error_during_execution` in particular often
    // carries an actionable string in `errors[]` (e.g. "Context window
    // exceeded").
    const turns = classifyRuntimeEvent({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      num_turns: 50,
      errors: [],
    });
    if (turns.kind === 'result') {
      expect(turns.isError).toBe(true);
      expect(turns.body.toLowerCase()).toMatch(/turn/);
    }

    const budget = classifyRuntimeEvent({
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: true,
      total_cost_usd: 10,
    });
    if (budget.kind === 'result') {
      expect(budget.body.toLowerCase()).toMatch(/budget|cost/);
    }

    const exec = classifyRuntimeEvent({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Context window exceeded'],
    });
    if (exec.kind === 'result') {
      expect(exec.body).toMatch(/Context window exceeded/);
    }

    const retries = classifyRuntimeEvent({
      type: 'result',
      subtype: 'error_max_structured_output_retries',
      is_error: true,
      errors: ['malformed json after 3 retries'],
    });
    if (retries.kind === 'result') {
      expect(retries.body.toLowerCase()).toMatch(/structured output|retries/);
    }
  });

  it('falls back to a sensible body when result has no result/error string', () => {
    const errEvent = classifyRuntimeEvent({
      type: 'result',
      subtype: 'error',
      is_error: true,
    });
    expect(errEvent.kind).toBe('result');
    if (errEvent.kind === 'result') {
      expect(errEvent.body).toBe('Task failed');
    }
    const okEvent = classifyRuntimeEvent({ type: 'result', subtype: 'success' });
    if (okEvent.kind === 'result') {
      expect(okEvent.body).toBe('Task complete');
    }
  });

  it('classifies rate_limit_event and exposes the info payload', () => {
    const info = { status: 'allowed_warning', utilization: 0.85 };
    const event = classifyRuntimeEvent({
      type: 'rate_limit_event',
      rate_limit_info: info,
    });
    expect(event.kind).toBe('rateLimit');
    if (event.kind === 'rateLimit') {
      expect(event.info).toBe(info);
    }
  });

  it('skips rate_limit_event without payload (treated as turn)', () => {
    const event = classifyRuntimeEvent({ type: 'rate_limit_event' });
    expect(event.kind).toBe('turn');
  });

  it('classifies assistant / user / tool_use / tool_result as turn', () => {
    expect(classifyRuntimeEvent({ type: 'assistant', message: { content: [] } }).kind)
      .toBe('turn');
    expect(classifyRuntimeEvent({ type: 'user', message: { content: [] } }).kind)
      .toBe('turn');
  });

  it('classifies non-hook, non-init/non-compact system messages as turn', () => {
    // OmniFex toast notifications are still turn-bucketed — they're rare and
    // typically arrive during a turn, so they don't strand a fresh session.
    expect(
      classifyRuntimeEvent({ type: 'system', subtype: 'notification' }).kind,
    ).toBe('turn');
  });

  // SessionStart hooks emit hook_started / hook_progress / hook_response
  // BEFORE any user turn. Treating them as 'turn' flips conversationStatus
  // to 'running' on a fresh idle session and never flips back (no result
  // is coming). Classify them as their own 'hook' kind so the FSM can
  // ignore them for status purposes while still forwarding the message
  // to the renderer for display.
  it("classifies SDK hook lifecycle subtypes as 'hook'", () => {
    expect(classifyRuntimeEvent({ type: 'system', subtype: 'hook_started' }).kind).toBe('hook');
    expect(classifyRuntimeEvent({ type: 'system', subtype: 'hook_progress' }).kind).toBe('hook');
    expect(classifyRuntimeEvent({ type: 'system', subtype: 'hook_response' }).kind).toBe('hook');
    expect(classifyRuntimeEvent({ type: 'system', subtype: 'user_prompt_submit' }).kind).toBe('hook');
  });

  it('classifies system:compact_boundary as its own kind with metadata', () => {
    // Per the SDK contract, SDKCompactBoundaryMessage carries
    // { compact_metadata: { trigger: 'manual'|'auto', pre_tokens: number } }.
    // Surfacing this as a distinct kind lets the FSM / status badge
    // distinguish "model is responding" from "stream paused for compaction"
    // instead of collapsing both into 'turn'.
    const event = classifyRuntimeEvent({
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'sess-1',
      compact_metadata: { trigger: 'auto', pre_tokens: 180_000 },
    });
    expect(event.kind).toBe('compact');
    if (event.kind === 'compact') {
      expect(event.trigger).toBe('auto');
      expect(event.preTokens).toBe(180_000);
    }
  });

  it('classifies stream_event (partial assistant message) as its own kind', () => {
    // SDKPartialAssistantMessage type === 'stream_event'. Opt-in via
    // includePartialMessages; treating it as 'turn' would double-flip
    // status on every token. Distinguishing it lets future code suppress
    // status churn while a turn is mid-flight.
    const event = classifyRuntimeEvent({
      type: 'stream_event',
      uuid: 'u-1',
      session_id: 'sess-1',
      event: { type: 'content_block_delta' },
    });
    expect(event.kind).toBe('streamEvent');
  });

  it('truncates body to 200 chars', () => {
    const long = 'x'.repeat(500);
    const event = classifyRuntimeEvent({
      type: 'result',
      subtype: 'success',
      result: long,
    });
    if (event.kind === 'result') {
      expect(event.body.length).toBe(200);
    }
  });
});

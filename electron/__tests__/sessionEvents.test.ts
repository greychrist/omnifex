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

  it('classifies non-init system messages (notifications, hook events, compact_boundary) as turn', () => {
    expect(
      classifyRuntimeEvent({ type: 'system', subtype: 'compact_boundary' }).kind,
    ).toBe('turn');
    expect(
      classifyRuntimeEvent({ type: 'system', subtype: 'notification' }).kind,
    ).toBe('turn');
    expect(
      classifyRuntimeEvent({ type: 'system', subtype: 'hook_started' }).kind,
    ).toBe('turn');
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

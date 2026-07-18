import { describe, it, expect } from 'vitest';
import { classifyJsonlLine } from '../jsonlClassifier';
import { JSONL_SAMPLES } from './fixtures/jsonl-samples';

describe('classifyJsonlLine', () => {
  it('classifies assistant lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['assistant']);
    expect(node?.kind).toBe('assistant');
    if (node?.kind === 'assistant') {
      expect(node.sessionId).toBeTruthy();
      expect(node.receivedAt).toBeTruthy();
      expect(node.raw.message.role).toBe('assistant');
    }
  });

  it('classifies a user prompt as userKind=prompt', () => {
    const sample = {
      type: 'user',
      sessionId: 'sid-1',
      timestamp: '2026-05-23T20:00:00Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') {
      expect(node.userKind).toBe('prompt');
    }
  });

  it('classifies a tool_result reply as userKind=tool-result', () => {
    const sample = {
      type: 'user',
      sessionId: 'sid-1',
      timestamp: '2026-05-23T20:00:01Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }],
      },
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('user');
    if (node?.kind === 'user') {
      expect(node.userKind).toBe('tool-result');
    }
  });

  it('classifies attachment lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['attachment']);
    expect(node?.kind).toBe('attachment');
  });

  it('classifies queue-operation lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['queue-operation']);
    expect(node?.kind).toBe('queue-operation');
  });

  it('returns null for malformed input', () => {
    expect(classifyJsonlLine(null)).toBeNull();
    expect(classifyJsonlLine(undefined)).toBeNull();
    expect(classifyJsonlLine('not an object')).toBeNull();
    expect(classifyJsonlLine({})).toBeNull();
  });

  it('returns kind: unknown for an unrecognized top-level type', () => {
    const node = classifyJsonlLine({ type: 'unknown-future-type', timestamp: '2026-05-27T00:00:00Z' });
    expect(node?.kind).toBe('unknown');
  });

  it('returns kind: unknown even when timestamp and receivedAt are both absent', () => {
    // The catch-all must catch: several real CLI record types (`summary`,
    // `mode`) ship with no top-level timestamp, and dropping them here meant
    // they could never render, on any path. Ordering falls back to file
    // position, which the history loader already preserves.
    const node = classifyJsonlLine({ type: 'unknown-future-type', sessionId: 's1' });
    expect(node?.kind).toBe('unknown');
    if (node?.kind === 'unknown') expect(node.receivedAt).toBeNull();
  });

  it('classifies a compaction summary record (no timestamp on disk) as unknown so SummaryWidget can render it', () => {
    const node = classifyJsonlLine({ type: 'summary', summary: 'Compacted: fixed the parser', leafUuid: 'u-1' });
    expect(node?.kind).toBe('unknown');
  });

  it('returns null only when BOTH timestamp and receivedAt are absent on a kind that requires receivedAt', () => {
    const raw = { type: 'assistant', sessionId: 's1', message: { role: 'assistant', content: [] } };
    expect(classifyJsonlLine(raw)).toBeNull();
  });

  it('accepts a live envelope that has receivedAt but no timestamp (main-process IPC stamping)', () => {
    // OmnifexEnvelope: live messages are stamped with receivedAt by main process.
    // The CLI stream-json output does not include a `timestamp` field.
    const raw = {
      type: 'assistant',
      sessionId: 's1',
      message: { role: 'assistant', content: [] },
      receivedAt: '2026-05-27T21:10:01.775Z',
    };
    const node = classifyJsonlLine(raw);
    expect(node?.kind).toBe('assistant');
    expect((node as { receivedAt?: string }).receivedAt).toBe('2026-05-27T21:10:01.775Z');
  });

  it('prefers timestamp over receivedAt when both are present (JSONL canonical wins)', () => {
    const raw = {
      type: 'assistant',
      sessionId: 's1',
      message: { role: 'assistant', content: [] },
      timestamp: '2026-05-27T21:10:01.775Z',
      receivedAt: '2026-05-27T21:10:02.999Z',
    };
    const node = classifyJsonlLine(raw);
    expect((node as { receivedAt?: string }).receivedAt).toBe('2026-05-27T21:10:01.775Z');
  });

  it('classifies last-prompt lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['last-prompt']);
    expect(node?.kind).toBe('last-prompt');
  });

  it('classifies permission-mode lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['permission-mode']);
    expect(node?.kind).toBe('permission-mode');
  });

  it('classifies ai-title lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['ai-title']);
    expect(node?.kind).toBe('ai-title');
  });

  it('classifies file-history-snapshot lines', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['file-history-snapshot']);
    expect(node?.kind).toBe('file-history-snapshot');
  });

  it('classifies system/stop_hook_summary', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['system/stop_hook_summary']);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('stop_hook_summary');
    }
  });

  it('classifies system/local_command', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['system/local_command']);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('local_command');
    }
  });

  it('classifies system/api_error', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['system/api_error']);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('api_error');
    }
  });

  it('classifies system/turn_duration', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['system/turn_duration']);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('turn_duration');
    }
  });

  it('classifies system/thinking_tokens', () => {
    const sample = {
      type: 'system',
      subtype: 'thinking_tokens',
      estimated_tokens: 800,
      estimated_tokens_delta: 50,
      uuid: 'e1d44641-7100-4fdd-8408-bdef7f745da7',
      sessionId: '0e1e60a9-7c56-4a8e-a185-3083ec130353',
      timestamp: '2026-04-29T17:19:18.835Z',
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('thinking_tokens');
    }
  });

  it('classifies rate_limit_event as its own top-level kind (not system — it has no subtype field)', () => {
    const sample = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 1784362200,
        rateLimitType: 'five_hour',
        overageStatus: 'rejected',
        overageDisabledReason: 'org_level_disabled',
        isUsingOverage: false,
      },
      uuid: 'e1d44641-7100-4fdd-8408-bdef7f745da7',
      session_id: '0e1e60a9-7c56-4a8e-a185-3083ec130353',
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('rate-limit-event');
    if (node?.kind === 'rate-limit-event') {
      expect(node.sessionId).toBe('0e1e60a9-7c56-4a8e-a185-3083ec130353');
      expect(node.raw.rate_limit_info?.status).toBe('allowed');
      expect(node.raw.rate_limit_info?.rateLimitType).toBe('five_hour');
    }
  });

  it('classifies rate_limit_event even with no rate_limit_info payload (degrades gracefully, never unknown)', () => {
    const node = classifyJsonlLine({ type: 'rate_limit_event', uuid: 'u1', session_id: 's1' });
    expect(node?.kind).toBe('rate-limit-event');
  });

  it('classifies system/away_summary', () => {
    const node = classifyJsonlLine(JSONL_SAMPLES['system/away_summary']);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('away_summary');
    }
  });

  it('classifies system/compact_boundary (manual sample — not in fixtures)', () => {
    const sample = {
      type: 'system',
      subtype: 'compact_boundary',
      sessionId: 'sid',
      timestamp: '2026-05-24T00:00:00Z',
      compactMetadata: { trigger: 'manual' },
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('compact_boundary');
    }
  });

  it('classifies system/informational (manual sample — not in fixtures)', () => {
    const sample = {
      type: 'system',
      subtype: 'informational',
      sessionId: 'sid',
      timestamp: '2026-05-24T00:00:00Z',
      content: 'info',
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('informational');
    }
  });

  it('classifies system/status (CLI request-state indicator)', () => {
    const sample = {
      type: 'system',
      subtype: 'status',
      status: 'requesting',
      uuid: '49edbb8a-1e0e-4640-91d0-7193843b7178',
      session_id: '3169eca7-891a-4881-a02f-bb09d6880cfb',
      timestamp: '2026-05-27T03:31:46.254Z',
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('status');
    }
  });

  it('classifies system/permission_denied (auto-mode classifier deny)', () => {
    const sample = {
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'toolu_0189V4WbvqBVYSBYgmySYFnc',
      decision_reason_type: 'classifier',
      decision_reason: 'glob reads across forbidden paths',
      message: 'Permission for this action was denied...',
      uuid: '7b31eb5e-1f79-4a4b-a09e-7efaab00104c',
      session_id: '3169eca7-891a-4881-a02f-bb09d6880cfb',
      timestamp: '2026-05-27T00:00:00Z',
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('permission_denied');
    }
  });

  it('classifies model-fallback and execution-error system subtypes as system nodes', () => {
    // Observed in real transcripts (Fable 5 safety-fallback notices carry a
    // user-facing `content` string). These were silently invisible before.
    const subtypes = [
      'model_fallback',
      'model_refusal_fallback',
      'model_refusal_no_fallback',
      'model_consent_fallback',
      'error_during_execution',
    ];
    for (const subtype of subtypes) {
      const node = classifyJsonlLine({
        type: 'system',
        subtype,
        content: 'Switching models',
        sessionId: 'sid',
        timestamp: '2026-07-14T00:00:00Z',
      });
      expect(node?.kind).toBe('system');
      if (node?.kind === 'system') expect(node.subtype).toBe(subtype);
    }
  });

  it('returns kind: unknown for system with unknown subtype', () => {
    const node = classifyJsonlLine({
      type: 'system',
      subtype: 'future_unknown_subtype',
      sessionId: 'sid',
      timestamp: '2026-05-24T00:00:00Z',
    });
    expect(node?.kind).toBe('unknown');
  });

  it('classifies system/init as cli-stream-init (engine-mode init envelope)', () => {
    const sample = {
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-sid-1',
      cwd: '/p',
      timestamp: '2026-05-27T00:00:00Z',
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('cli-stream-init');
    if (node?.kind === 'cli-stream-init') {
      expect(node.sessionId).toBe('sdk-sid-1');
    }
  });

  it('classifies system/notification (CLI iterator shape)', () => {
    const sample = {
      type: 'system',
      subtype: 'notification',
      session_id: 'sdk-sid-2',
      notification_type: 'error',
      title: 'oops',
      body: 'something broke',
      timestamp: '2026-05-27T00:00:00Z',
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('notification');
    }
  });

  it('reads snake_case session_id for CLI iterator messages', () => {
    const sample = {
      type: 'assistant',
      session_id: 'sdk-snake',
      timestamp: '2026-05-27T00:00:00Z',
      message: { role: 'assistant', content: [] },
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('assistant');
    if (node?.kind === 'assistant') {
      expect(node.sessionId).toBe('sdk-snake');
    }
  });

  it('prefers camelCase sessionId over snake_case when both present', () => {
    const sample = {
      type: 'assistant',
      sessionId: 'cs-camel',
      session_id: 'should-not-win',
      timestamp: '2026-05-27T00:00:00Z',
      message: { role: 'assistant', content: [] },
    };
    const node = classifyJsonlLine(sample);
    if (node?.kind === 'assistant') {
      expect(node.sessionId).toBe('cs-camel');
    }
  });

  it('classifies result events as cli-stream-result', () => {
    const sample = {
      type: 'result',
      subtype: 'success',
      session_id: 'sdk-sid-3',
      timestamp: '2026-05-27T00:00:00Z',
      result: 'All done.',
      is_error: false,
      duration_ms: 3000,
      total_cost_usd: 0.0012,
      stop_reason: 'end_turn',
      usage: { input_tokens: 200, output_tokens: 80 },
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('cli-stream-result');
  });
});

describe('CLI stream-json envelopes (engine mode)', () => {
  it('classifies a system:init envelope as cli-stream-init', () => {
    const raw = {
      type: 'system',
      subtype: 'init',
      session_id: 'abc',
      cwd: '/work',
      timestamp: '2026-05-27T00:00:00Z',
    };
    const node = classifyJsonlLine(raw);
    expect(node?.kind).toBe('cli-stream-init');
  });

  it('classifies a result envelope as cli-stream-result', () => {
    const raw = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1234,
      session_id: 'abc',
      timestamp: '2026-05-27T00:00:00Z',
    };
    const node = classifyJsonlLine(raw);
    expect(node?.kind).toBe('cli-stream-result');
  });

  it('classifies a result error_during_execution envelope as cli-stream-result', () => {
    const raw = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: '',
      duration_ms: 4679375,
      duration_api_ms: 0,
      num_turns: 0,
      stop_reason: null,
      total_cost_usd: 0.000138,
      session_id: 'c0e34556-8703-4a95-9ee2-999180bc7cf1',
      timestamp: '2026-05-27T00:00:00Z',
    };
    const node = classifyJsonlLine(raw);
    expect(node?.kind).toBe('cli-stream-result');
  });

  it('cli-stream-init preserves sessionId from session_id field', () => {
    const raw = {
      type: 'system',
      subtype: 'init',
      session_id: 'my-session',
      timestamp: '2026-05-27T00:00:00Z',
    };
    const node = classifyJsonlLine(raw);
    expect(node?.kind).toBe('cli-stream-init');
    if (node?.kind === 'cli-stream-init') {
      expect(node.sessionId).toBe('my-session');
    }
  });

  it('cli-stream-init returns null when timestamp is missing', () => {
    const raw = {
      type: 'system',
      subtype: 'init',
      session_id: 'abc',
    };
    const node = classifyJsonlLine(raw);
    expect(node).toBeNull();
  });

  it('non-init system subtypes still classify as system (not cli-stream-init)', () => {
    const raw = {
      type: 'system',
      subtype: 'notification',
      session_id: 'abc',
      timestamp: '2026-05-27T00:00:00Z',
      notification_type: 'info',
      title: 'test',
      body: 'hello',
    };
    const node = classifyJsonlLine(raw);
    expect(node?.kind).toBe('system');
  });
});

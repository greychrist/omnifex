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
    expect(classifyJsonlLine({ type: 'unknown-future-type' })).toBeNull();
  });

  it('uses receivedAt fallback when timestamp is missing', () => {
    const sample = {
      type: 'assistant',
      sessionId: 'sid-2',
      message: { role: 'assistant', content: [] },
    };
    const before = Date.now();
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('assistant');
    if (node?.kind === 'assistant') {
      const stamp = Date.parse(node.receivedAt);
      expect(stamp).toBeGreaterThanOrEqual(before);
    }
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

  it('returns null for system with unknown subtype', () => {
    const node = classifyJsonlLine({
      type: 'system',
      subtype: 'future_unknown_subtype',
      sessionId: 'sid',
      timestamp: '2026-05-24T00:00:00Z',
    });
    expect(node).toBeNull();
  });

  it('classifies system/init (SDK iterator shape)', () => {
    const sample = {
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-sid-1',
      cwd: '/p',
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('init');
      expect(node.sessionId).toBe('sdk-sid-1');
    }
  });

  it('classifies system/notification (SDK iterator shape)', () => {
    const sample = {
      type: 'system',
      subtype: 'notification',
      session_id: 'sdk-sid-2',
      notification_type: 'error',
      title: 'oops',
      body: 'something broke',
    };
    const node = classifyJsonlLine(sample);
    expect(node?.kind).toBe('system');
    if (node?.kind === 'system') {
      expect(node.subtype).toBe('notification');
    }
  });

  it('reads snake_case session_id for SDK iterator messages', () => {
    const sample = {
      type: 'assistant',
      session_id: 'sdk-snake',
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
      message: { role: 'assistant', content: [] },
    };
    const node = classifyJsonlLine(sample);
    if (node?.kind === 'assistant') {
      expect(node.sessionId).toBe('cs-camel');
    }
  });
});

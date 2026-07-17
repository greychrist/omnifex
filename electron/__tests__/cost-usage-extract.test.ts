import { describe, it, expect } from 'vitest';
import { extractDedupedUsage } from '../services/cost/usage-extract';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

const usageA = { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 50 };

describe('extractDedupedUsage', () => {
  it('extracts assistant lines with usage, skips others and garbage', () => {
    const content = [
      line({ type: 'user', message: {} }),
      'not json at all',
      line({ type: 'assistant', requestId: 'req_1', timestamp: '2026-07-17T01:02:03.000Z', message: { id: 'msg_1', model: 'claude-opus-4-8', usage: usageA } }),
      line({ type: 'assistant', message: { id: 'msg_nousage', model: 'claude-opus-4-8' } }),
    ].join('\n');
    const rows = extractDedupedUsage(content);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      key: 'req_1',
      model: 'claude-opus-4-8',
      timestamp: '2026-07-17T01:02:03.000Z',
      usage: usageA,
    });
  });

  it('dedups multi-block messages sharing requestId — last occurrence wins', () => {
    const content = [
      line({ type: 'assistant', requestId: 'req_1', timestamp: '2026-07-17T01:00:00Z', message: { id: 'msg_1', model: 'claude-opus-4-8', usage: { input_tokens: 2, output_tokens: 10 } } }),
      line({ type: 'assistant', requestId: 'req_1', timestamp: '2026-07-17T01:00:01Z', message: { id: 'msg_1', model: 'claude-opus-4-8', usage: { input_tokens: 2, output_tokens: 99 } } }),
      line({ type: 'assistant', requestId: 'req_2', timestamp: '2026-07-17T01:00:02Z', message: { id: 'msg_2', model: 'claude-opus-4-8', usage: usageA } }),
    ].join('\n');
    const rows = extractDedupedUsage(content);
    expect(rows).toHaveLength(2);
    expect(rows[0].usage.output_tokens).toBe(99);
    expect(rows[1].key).toBe('req_2');
  });

  it('falls back to message.id then per-line key', () => {
    const content = [
      line({ type: 'assistant', message: { id: 'msg_only', model: 'claude-sonnet-5', usage: usageA } }),
      line({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: usageA } }),
      line({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: usageA } }),
    ].join('\n');
    const rows = extractDedupedUsage(content);
    expect(rows).toHaveLength(3);
    expect(rows[0].key).toBe('msg_only');
    expect(rows[1].key).not.toBe(rows[2].key);
  });

  it('missing model becomes "unknown", missing timestamp empty string', () => {
    const rows = extractDedupedUsage(line({ type: 'assistant', message: { id: 'm', usage: usageA } }));
    expect(rows[0].model).toBe('unknown');
    expect(rows[0].timestamp).toBe('');
  });
});

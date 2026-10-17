import { describe, it, expect } from 'vitest';
import { extractDedupedUsage, extractSessionUsage } from '../services/cost/usage-extract';

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

describe('extractSessionUsage', () => {
  const asst = (req: string, usage: unknown) =>
    line({ type: 'assistant', requestId: req, timestamp: '2026-10-17T01:00:00Z', message: { id: `msg_${req}`, model: 'claude-opus-5-5', usage } });

  it('drops a fork transcript\'s copy of the parent request, keeping the main loop\'s', () => {
    // A fork's agent-<id>.jsonl opens with a fork-context-ref and a copy of
    // the parent's assistant record that made the Agent call — same
    // requestId, full usage (CLI 2.1.302).
    const main = [asst('req_parent', { output_tokens: 538, cache_read_input_tokens: 70507 })].join('\n');
    const fork = [
      line({ type: 'fork-context-ref', agentId: 'f1', parentSessionId: 's', parentLastUuid: 'u', contextLength: 69 }),
      asst('req_parent', { output_tokens: 538, cache_read_input_tokens: 70507 }),
      asst('req_fork', { output_tokens: 5 }),
    ].join('\n');
    const result = extractSessionUsage(main, [{ agentId: 'f1', content: fork }]);
    expect(result.main.map((r) => r.key)).toEqual(['req_parent']);
    expect(result.subagents).toEqual([{ agentId: 'f1', rows: [expect.objectContaining({ key: 'req_fork' })] }]);
  });

  it('drops a request already claimed by an earlier subagent file', () => {
    const result = extractSessionUsage('', [
      { agentId: 'a', content: asst('req_a', { output_tokens: 1 }) },
      { agentId: 'b', content: [asst('req_a', { output_tokens: 1 }), asst('req_b', { output_tokens: 2 })].join('\n') },
    ]);
    expect(result.subagents.map((s) => [s.agentId, s.rows.map((r) => r.key)])).toEqual([
      ['a', ['req_a']],
      ['b', ['req_b']],
    ]);
  });

  it('never collapses line-number fallback keys across files', () => {
    const noIds = line({ type: 'assistant', message: { model: 'm', usage: usageA } });
    const result = extractSessionUsage(noIds, [{ agentId: 'a', content: noIds }]);
    expect(result.main).toHaveLength(1);
    expect(result.subagents[0].rows).toHaveLength(1);
  });
});

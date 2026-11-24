// @vitest-environment node
//
// Sessions ask the CLI for summarized thinking. Under its default ("updates")
// the stream carries only token counts — thinking_delta.thinking is always
// "" — so a chat cannot show a thought being typed out. "summarized" streams
// the thought's text as thinking_delta and writes it to the record. Verified
// against CLI 2.1.312, Opus and Sonnet, 2026-10-28.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const written: string[] = [];
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void; pid: number;
  };
  child.stdin = new PassThrough();
  child.stdin.on('data', (chunk: Buffer) => { written.push(chunk.toString()); });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  child.pid = 4242;
  setImmediate(() => child.emit('spawn'));
  return child;
}
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => fakeChild()) }));

import { createClaudeCliEngine } from '../services/agents/claude-cli-engine';

beforeEach(() => { written.length = 0; });

const lines = () => written.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

describe('ClaudeCliEngine — thinking display', () => {
  it('asks for summarized thinking as soon as the process starts, before any prompt', async () => {
    const engine = createClaudeCliEngine({ tabId: 't1', claudeBinaryPath: '/bin/claude' });
    await engine.start({ projectPath: '/tmp/p', configDir: '/tmp/cfg', sessionId: '11111111-2222-4333-8444-555555555555', resume: false });
    await engine.send('hello');
    const sent = lines();
    const i = sent.findIndex((l) => l.type === 'control_request' && l.request?.subtype === 'set_max_thinking_tokens');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(sent[i].request).toEqual({ subtype: 'set_max_thinking_tokens', thinking_display: 'summarized' });
    // Display only: the budget key is absent, so the CLI leaves the budget alone.
    expect('max_thinking_tokens' in sent[i].request).toBe(false);
    expect(i).toBeLessThan(sent.findIndex((l) => l.type === 'user'));
  });
});

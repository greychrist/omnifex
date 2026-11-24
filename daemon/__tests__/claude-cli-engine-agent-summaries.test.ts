// @vitest-environment node
//
// Sessions ask the CLI for its own subagent progress summaries: with
// `agentProgressSummaries` set in `initialize`, each running agent's
// task_progress frame carries a `summary` ("Reading runAgent.ts") written by
// the CLI about every 30 s. It replaced OmniFex's bundled progress mod, which
// asked every agent to report through a tool call (2026-11-24 trial: the tool
// was skipped by most agents and cost up to 57% of one agent's spend).
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

describe('ClaudeCliEngine — agent progress summaries', () => {
  it('turns on the CLI\'s agent progress summaries at start, before any prompt', async () => {
    const engine = createClaudeCliEngine({ tabId: 't1', claudeBinaryPath: '/bin/claude' });
    await engine.start({ projectPath: '/tmp/p', configDir: '/tmp/cfg', sessionId: '11111111-2222-4333-8444-555555555555', resume: false });
    await engine.send('hello');
    const sent = lines();
    const i = sent.findIndex((l) => l.type === 'control_request' && l.request?.subtype === 'initialize');
    expect(i).toBeGreaterThanOrEqual(0);
    // Only the one option: everything else in initialize is one-time session
    // setup that OmniFex gives on argv instead.
    expect(sent[i].request).toEqual({ subtype: 'initialize', agentProgressSummaries: true });
    expect(i).toBeLessThan(sent.findIndex((l) => l.type === 'user'));
  });
});

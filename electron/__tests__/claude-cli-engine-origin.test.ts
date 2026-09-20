// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// A fake CLI child: stdin captures what the engine writes; stdout/stderr are
// inert; 'spawn' fires on the next tick so start() resolves.
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

async function startedEngine() {
  const engine = createClaudeCliEngine({ tabId: 't1', claudeBinaryPath: '/bin/claude' });
  await engine.start({
    projectPath: '/tmp/p', configDir: '/tmp/cfg', sessionId: '11111111-2222-4333-8444-555555555555', resume: false,
  });
  return engine;
}

const lastLine = () => JSON.parse(written.join('').trim().split('\n').at(-1) as string) as Record<string, unknown>;

// The CLI's stream-json user schema documents the field: "A host wrapping
// keyboard input must stamp {kind:'human'} explicitly — absent origin is
// treated as unattributed and fails closed at strict isHuman() trust gates."
// From 2.1.277 an unstamped prompt no longer qualifies for the CLI's own
// session naming (0 of 36 OmniFex sessions titled; 100% before).
describe('ClaudeCliEngine — prompts are stamped as human input', () => {
  it('stamps origin {kind:"human"} on a text prompt', async () => {
    const engine = await startedEngine();
    await engine.send('name this session');
    expect(lastLine()).toMatchObject({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'name this session' }] },
      parent_tool_use_id: null,
      session_id: '11111111-2222-4333-8444-555555555555',
      origin: { kind: 'human' },
    });
  });

  it('stamps origin {kind:"human"} on a structured (image-bearing) prompt', async () => {
    const engine = await startedEngine();
    await engine.sendStructured([{ type: 'text', text: 'see' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]);
    expect(lastLine()).toMatchObject({ type: 'user', origin: { kind: 'human' } });
    expect((lastLine().message as { content: unknown[] }).content).toHaveLength(2);
  });
});

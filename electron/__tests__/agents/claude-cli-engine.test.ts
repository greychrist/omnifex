import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createClaudeCliEngine } from '../../services/agents/claude-cli-engine';
import type { AgentEngineExit, AgentMessage } from '../../services/agents/types';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../services/util/claude-env', () => ({
  buildClaudeEnv: (configDir: string) => ({ CLAUDE_CONFIG_DIR: configDir }),
}));

const mockedSpawn = vi.mocked(spawn);

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable & { _writes: string[] };
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

function makeFakeChild(): FakeChild {
  const emitter = new EventEmitter() as FakeChild;
  emitter.stdout = new Readable({ read() {} });
  emitter.stderr = new Readable({ read() {} });
  const writes: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      writes.push(chunk.toString('utf8'));
      cb();
    },
  }) as Writable & { _writes: string[] };
  stdin._writes = writes;
  emitter.stdin = stdin;
  emitter.kill = vi.fn();
  emitter.pid = 4242;
  setImmediate(() => emitter.emit('spawn'));
  return emitter;
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

const baseParams = {
  projectPath: '/proj',
  configDir: '/home/user/.claude',
  model: 'claude-opus-4-8',
  permissionMode: 'default',
  sessionId: 'sess-1',
  resume: false,
};

beforeEach(() => {
  mockedSpawn.mockReset();
});

describe('ClaudeCliEngine', () => {
  it('spawns the CLI in stream-json mode with --session-id on cold start', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({ tabId: 't', claudeBinaryPath: '/bin/claude' });

    await engine.start(baseParams);

    const [cmd, args, opts] = mockedSpawn.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
    expect(cmd).toBe('/bin/claude');
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-1');
    expect(args).not.toContain('--resume');
    expect(args).toContain('--output-format');
    expect(opts.cwd).toBe('/proj');
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/home/user/.claude');
  });

  it('passes --model for a concrete model id', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({ tabId: 't', claudeBinaryPath: '/bin/claude' });

    await engine.start({ ...baseParams, model: 'sonnet' });

    const args = mockedSpawn.mock.calls[0]![1] as string[];
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
  });

  it("omits --model when the selection is 'default' (let the CLI pick)", async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({ tabId: 't', claudeBinaryPath: '/bin/claude' });

    await engine.start({ ...baseParams, model: 'default' });

    const args = mockedSpawn.mock.calls[0]![1] as string[];
    expect(args).not.toContain('--model');
  });

  it('uses --resume (not --session-id) on a warm restart', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({ tabId: 't', claudeBinaryPath: '/bin/claude' });

    await engine.start({ ...baseParams, resume: true });
    const args = mockedSpawn.mock.calls[0]![1] as string[];
    expect(args).toContain('--resume');
    expect(args).not.toContain('--session-id');
  });

  it('forwards a parsed stdout line to onMessage subscribers', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({ tabId: 'tab-9', claudeBinaryPath: '/bin/claude' });
    const received: AgentMessage[] = [];
    engine.onMessage((m) => received.push(m));

    await engine.start(baseParams);
    fake.stdout.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }) + '\n');
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0]!.tabId).toBe('tab-9');
    expect((received[0]!.payload as { type: string }).type).toBe('system');
  });

  it('surfaces a stderr line via onError', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({ tabId: 't', claudeBinaryPath: '/bin/claude' });
    const errors: string[] = [];
    engine.onError((e) => errors.push(e.message));

    await engine.start(baseParams);
    fake.stderr.push('something on stderr\n');
    await flush();

    expect(errors).toContain('something on stderr');
  });

  it('writes a user message to stdin on send()', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({ tabId: 't', claudeBinaryPath: '/bin/claude' });

    await engine.start(baseParams);
    await engine.send('hello there');

    expect(fake.stdin._writes).toHaveLength(1);
    const sent = JSON.parse(fake.stdin._writes[0]!.trim());
    expect(sent.type).toBe('user');
    expect(sent.message.content).toEqual([{ type: 'text', text: 'hello there' }]);
  });

  it('fires onExit when the child exits', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({ tabId: 't', claudeBinaryPath: '/bin/claude' });
    const exits: AgentEngineExit[] = [];
    engine.onExit((info) => exits.push(info));

    await engine.start(baseParams);
    fake.emit('exit', 0, null);

    expect(exits).toHaveLength(1);
    expect(exits[0]!.code).toBe(0);
  });

  it('does not fire onExit for the OLD child after a restart (F2)', async () => {
    const childA = makeFakeChild();
    const childB = makeFakeChild();
    mockedSpawn.mockReturnValueOnce(childA as never).mockReturnValueOnce(childB as never);

    const engine = createClaudeCliEngine({ tabId: 't', claudeBinaryPath: '/bin/claude' });
    const exits: AgentEngineExit[] = [];
    engine.onExit((info) => exits.push(info));

    await engine.start(baseParams);
    // Restart (e.g. restartQuery after a stream death) — spawns childB and
    // tears down childA.
    await engine.start({ ...baseParams, resume: true });

    // The old child's delayed exit must NOT reach our exit callbacks, or the
    // runtime would delete the just-restarted session.
    childA.emit('exit', 143, 'SIGTERM');
    await flush();
    expect(exits).toHaveLength(0);

    // The live child's exit still works.
    childB.emit('exit', 0, null);
    await flush();
    expect(exits).toHaveLength(1);
    expect(exits[0]!.code).toBe(0);
  });

  it('kills the outgoing child on restart', async () => {
    const childA = makeFakeChild();
    const childB = makeFakeChild();
    mockedSpawn.mockReturnValueOnce(childA as never).mockReturnValueOnce(childB as never);
    const engine = createClaudeCliEngine({ tabId: 't', claudeBinaryPath: '/bin/claude' });

    await engine.start(baseParams);
    await engine.start({ ...baseParams, resume: true });

    expect(childA.kill).toHaveBeenCalled();
  });
});

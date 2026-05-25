import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createClaudeCliEngine } from '../../services/agents/claude-cli-engine';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
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
  emitter.pid = 12345;
  return emitter;
}

beforeEach(() => {
  mockedSpawn.mockReset();
});

describe('ClaudeCliEngine', () => {
  describe('start()', () => {
    it('spawns the claude binary with stream-json IO flags and CLAUDE_CONFIG_DIR set', async () => {
      const fake = makeFakeChild();
      mockedSpawn.mockReturnValue(fake as never);

      const engine = createClaudeCliEngine({
        tabId: 'tab-1',
        claudeBinaryPath: '/usr/local/bin/claude',
      });
      await engine.start({
        projectPath: '/proj',
        configDir: '/conf',
        model: 'sonnet',
      });

      expect(mockedSpawn).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = mockedSpawn.mock.calls[0] as [
        string,
        string[],
        { cwd: string; env: NodeJS.ProcessEnv },
      ];
      expect(cmd).toBe('/usr/local/bin/claude');
      expect(args).toEqual(
        expect.arrayContaining([
          '--output-format',
          'stream-json',
          '--input-format',
          'stream-json',
          '--include-partial-messages',
          '--model',
          'sonnet',
        ]),
      );
      expect(opts.cwd).toBe('/proj');
      expect(opts.env.CLAUDE_CONFIG_DIR).toBe('/conf');
    });

    it('adds --resume <id> when resumeSessionId is set', async () => {
      const fake = makeFakeChild();
      mockedSpawn.mockReturnValue(fake as never);

      const engine = createClaudeCliEngine({
        tabId: 'tab-2',
        claudeBinaryPath: '/usr/local/bin/claude',
      });
      await engine.start({
        projectPath: '/proj',
        configDir: '/conf',
        resumeSessionId: 'sess-resume-abc',
      });

      const args = mockedSpawn.mock.calls[0][1] as string[];
      expect(args).toEqual(expect.arrayContaining(['--resume', 'sess-resume-abc']));
    });
  });

  describe('onMessage', () => {
    async function flushMicrotasks(): Promise<void> {
      await new Promise((r) => setImmediate(r));
    }

    it('parses NDJSON lines into onMessage events', async () => {
      const fake = makeFakeChild();
      mockedSpawn.mockReturnValue(fake as never);
      const engine = createClaudeCliEngine({
        tabId: 'tm',
        claudeBinaryPath: '/usr/local/bin/claude',
      });
      const received: AgentMessageT[] = [];
      engine.onMessage((m) => received.push(m));

      await engine.start({ projectPath: '/p', configDir: '/c' });

      fake.stdout.push(
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }) + '\n',
      );
      fake.stdout.push(
        JSON.stringify({ type: 'assistant', message: { content: 'hi' } }) + '\n',
      );
      await flushMicrotasks();

      expect(received).toHaveLength(2);
      expect(received[0].agent).toBe('claude');
      expect(received[0].tabId).toBe('tm');
      expect((received[0].payload as { type: string }).type).toBe('system');
      expect((received[1].payload as { type: string }).type).toBe('assistant');
    });

    it('handles split lines across chunk boundaries', async () => {
      const fake = makeFakeChild();
      mockedSpawn.mockReturnValue(fake as never);
      const engine = createClaudeCliEngine({
        tabId: 'tm2',
        claudeBinaryPath: '/usr/local/bin/claude',
      });
      const received: AgentMessageT[] = [];
      engine.onMessage((m) => received.push(m));

      await engine.start({ projectPath: '/p', configDir: '/c' });

      const full = JSON.stringify({ type: 'assistant', message: { id: 'm1' } });
      const halfway = Math.floor(full.length / 2);
      fake.stdout.push(full.slice(0, halfway));
      await flushMicrotasks();
      expect(received).toHaveLength(0);

      fake.stdout.push(full.slice(halfway) + '\n');
      await flushMicrotasks();

      expect(received).toHaveLength(1);
      expect((received[0].payload as { message: { id: string } }).message.id).toBe('m1');
    });

    it('captures session_id from system:init for getResumeId()', async () => {
      const fake = makeFakeChild();
      mockedSpawn.mockReturnValue(fake as never);
      const engine = createClaudeCliEngine({
        tabId: 'tm3',
        claudeBinaryPath: '/usr/local/bin/claude',
      });

      await engine.start({ projectPath: '/p', configDir: '/c' });
      expect(engine.getResumeId()).toBeNull();

      fake.stdout.push(
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'freshid' }) +
          '\n',
      );
      await flushMicrotasks();

      expect(engine.getResumeId()).toBe('freshid');
    });
  });
});

// Type alias used by the new tests above. Imported lazily so the existing
// spawn-skeleton tests don't need to know about it.
type AgentMessageT = import('../../services/agents/types').AgentMessage;

describe('ClaudeCliEngine permission protocol', () => {
  async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setImmediate(r));
  }

  it('forwards control_request:permission_request to onPermissionRequest', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({
      tabId: 'tab-perm',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    const reqs: import('../../services/agents/types').AgentPermissionRequest[] = [];
    engine.onPermissionRequest((r) => reqs.push(r));

    await engine.start({ projectPath: '/p', configDir: '/c' });

    fake.stdout.push(
      JSON.stringify({
        type: 'control_request',
        subtype: 'permission_request',
        request_id: 'pr1',
        tool_name: 'Bash',
        input: { command: 'ls' },
      }) + '\n',
    );
    await flushMicrotasks();

    expect(reqs).toHaveLength(1);
    expect(reqs[0].agent).toBe('claude');
    expect(reqs[0].requestId).toBe('pr1');
    expect(reqs[0].kind).toBe('tool');
    expect(reqs[0].summary).toContain('Bash');
    expect((reqs[0].payload as { tool_name: string }).tool_name).toBe('Bash');
  });

  it('does NOT also emit permission_request as a normal onMessage', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({
      tabId: 'tab-perm2',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    const msgs: AgentMessageT[] = [];
    engine.onMessage((m) => msgs.push(m));
    engine.onPermissionRequest(() => {});

    await engine.start({ projectPath: '/p', configDir: '/c' });
    fake.stdout.push(
      JSON.stringify({
        type: 'control_request',
        subtype: 'permission_request',
        request_id: 'pr-x',
        tool_name: 'Read',
        input: {},
      }) + '\n',
    );
    await flushMicrotasks();

    expect(msgs).toHaveLength(0);
  });

  it('respondPermission ships a control_response on stdin with right id', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({
      tabId: 'tab-perm3',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    await engine.start({ projectPath: '/p', configDir: '/c' });

    await engine.respondPermission('pr2', 'allow');

    expect(fake.stdin._writes).toHaveLength(1);
    const parsed = JSON.parse(fake.stdin._writes[0].trim());
    expect(parsed.type).toBe('control_response');
    expect(parsed.request_id).toBe('pr2');
    expect(parsed.decision).toBe('allow');
  });
});

describe('ClaudeCliEngine.getInitData', () => {
  async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setImmediate(r));
  }

  it('captures account/commands/models/agents from system:init', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({
      tabId: 'tab-init',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    await engine.start({ projectPath: '/p', configDir: '/c' });

    expect(engine.getInitData()).toBeNull();

    fake.stdout.push(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's',
        account: { email: 'a@b.com', organizationName: 'org' },
        commands: [{ name: 'help' }, { name: 'clear' }],
        models: [{ id: 'sonnet' }, { id: 'opus' }],
        agents: [{ name: 'reviewer' }],
      }) + '\n',
    );
    await flushMicrotasks();

    const init = engine.getInitData();
    expect(init).not.toBeNull();
    expect((init!.account as { email: string }).email).toBe('a@b.com');
    expect(init!.commands).toHaveLength(2);
    expect(init!.models).toHaveLength(2);
    expect(init!.agents).toHaveLength(1);
  });
});

describe('ClaudeCliEngine.sendControlRequest', () => {
  async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setImmediate(r));
  }

  it('writes a control_request with auto-generated id and resolves on matching response', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({
      tabId: 'tab-ctrl',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    await engine.start({ projectPath: '/p', configDir: '/c' });

    const pending = engine.sendControlRequest<{ ok: true }>('set_model', { model: 'sonnet' });

    expect(fake.stdin._writes).toHaveLength(1);
    const sent = JSON.parse(fake.stdin._writes[0].trim());
    expect(sent.type).toBe('control_request');
    expect(typeof sent.request_id).toBe('string');
    expect(sent.request_id.length).toBeGreaterThan(0);
    expect(sent.request.subtype).toBe('set_model');
    expect(sent.request.model).toBe('sonnet');

    fake.stdout.push(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: sent.request_id,
          response: { ok: true },
        },
      }) + '\n',
    );
    await flushMicrotasks();

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('resolves concurrent in-flight requests to the right promises', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({
      tabId: 'tab-conc',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    await engine.start({ projectPath: '/p', configDir: '/c' });

    const a = engine.sendControlRequest<{ tag: 'A' }>('get_a');
    const b = engine.sendControlRequest<{ tag: 'B' }>('get_b');

    const sentA = JSON.parse(fake.stdin._writes[0].trim());
    const sentB = JSON.parse(fake.stdin._writes[1].trim());

    // Reply in reverse order.
    fake.stdout.push(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: sentB.request_id,
          response: { tag: 'B' },
        },
      }) + '\n',
    );
    fake.stdout.push(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: sentA.request_id,
          response: { tag: 'A' },
        },
      }) + '\n',
    );
    await flushMicrotasks();

    await expect(a).resolves.toEqual({ tag: 'A' });
    await expect(b).resolves.toEqual({ tag: 'B' });
  });

  it('rejects when control_response.subtype is "error"', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({
      tabId: 'tab-err',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    await engine.start({ projectPath: '/p', configDir: '/c' });

    const pending = engine.sendControlRequest('mcp_status');
    // Pre-subscribe so the rejection produced when we push the error response
    // below isn't classified as "unhandled" — `expect().rejects` only attaches
    // after the awaited microtask.
    const assertion = expect(pending).rejects.toThrow(/boom/);

    const sent = JSON.parse(fake.stdin._writes[0].trim());

    fake.stdout.push(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: sent.request_id,
          error: 'boom',
        },
      }) + '\n',
    );
    await flushMicrotasks();

    await assertion;
  });

  it('resolves to undefined for void responses', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({
      tabId: 'tab-void',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    await engine.start({ projectPath: '/p', configDir: '/c' });

    const pending = engine.sendControlRequest('interrupt');
    const sent = JSON.parse(fake.stdin._writes[0].trim());

    fake.stdout.push(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: sent.request_id },
      }) + '\n',
    );
    await flushMicrotasks();

    await expect(pending).resolves.toBeUndefined();
  });
});

describe('ClaudeCliEngine restart-on-stream-death', () => {
  async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setImmediate(r));
  }

  it('start() is re-entrant — second call with resumeSessionId spawns a fresh child with --resume', async () => {
    const first = makeFakeChild();
    const second = makeFakeChild();
    mockedSpawn.mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);

    const engine = createClaudeCliEngine({
      tabId: 'tab-rs',
      claudeBinaryPath: '/usr/local/bin/claude',
    });

    await engine.start({ projectPath: '/p', configDir: '/c' });
    first.stdout.push(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-rs' }) + '\n',
    );
    await flushMicrotasks();
    first.emit('exit', 1, null);
    await flushMicrotasks();

    await engine.start({
      projectPath: '/p',
      configDir: '/c',
      resumeSessionId: engine.getResumeId() ?? undefined,
    });

    expect(mockedSpawn).toHaveBeenCalledTimes(2);
    const secondArgs = mockedSpawn.mock.calls[1][1] as string[];
    expect(secondArgs).toEqual(expect.arrayContaining(['--resume', 'sess-rs']));
  });
});

describe('ClaudeCliEngine lifecycle callbacks', () => {
  async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setImmediate(r));
  }

  it('onExit fires when child emits exit', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({
      tabId: 'tab-exit',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    const exits: import('../../services/agents/types').AgentEngineExit[] = [];
    engine.onExit((info) => exits.push(info));
    await engine.start({ projectPath: '/p', configDir: '/c' });

    fake.emit('exit', 0, null);
    await flushMicrotasks();

    expect(exits).toHaveLength(1);
    expect(exits[0].code).toBe(0);
    expect(exits[0].signal).toBeNull();
  });

  it('onError fires on stderr lines', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({
      tabId: 'tab-err',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    const errs: Error[] = [];
    engine.onError((e) => errs.push(e));
    await engine.start({ projectPath: '/p', configDir: '/c' });

    fake.stderr.push('connection refused\n');
    await flushMicrotasks();

    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('connection refused');
  });

  it('close() sends SIGTERM and is idempotent', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({
      tabId: 'tab-cls',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    await engine.start({ projectPath: '/p', configDir: '/c' });

    await engine.close();
    await engine.close();

    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('ClaudeCliEngine.interrupt()', () => {
  async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setImmediate(r));
  }

  it('writes a control_request:interrupt to stdin and awaits the matching response', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({
      tabId: 'tab-int',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    await engine.start({ projectPath: '/p', configDir: '/c' });

    const pending = engine.interrupt();

    expect(fake.stdin._writes).toHaveLength(1);
    const parsed = JSON.parse(fake.stdin._writes[0].trim());
    expect(parsed.type).toBe('control_request');
    expect(parsed.request.subtype).toBe('interrupt');
    expect(typeof parsed.request_id).toBe('string');

    fake.stdout.push(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: parsed.request_id },
      }) + '\n',
    );
    await flushMicrotasks();
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('ClaudeCliEngine.send()', () => {
  async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setImmediate(r));
  }

  it('writes a well-formed stream-json user message to stdin', async () => {
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({
      tabId: 'tab-send',
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    await engine.start({ projectPath: '/p', configDir: '/c' });

    fake.stdout.push(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'send-sess' }) +
        '\n',
    );
    await flushMicrotasks();

    await engine.send('hello world');

    expect(fake.stdin._writes).toHaveLength(1);
    const raw = fake.stdin._writes[0];
    expect(raw.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(raw.trim());
    expect(parsed.type).toBe('user');
    expect(parsed.message.role).toBe('user');
    expect(parsed.message.content[0].text).toBe('hello world');
    expect(parsed.session_id).toBe('send-sess');
    expect(parsed.parent_tool_use_id).toBeNull();
  });
});

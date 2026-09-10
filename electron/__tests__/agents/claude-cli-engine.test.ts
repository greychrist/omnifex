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

  it('enables --forward-subagent-text so subagent narration reaches the stream', async () => {
    // CLI ≥2.1.211: forwards subagent text/thinking as assistant envelopes
    // tagged with parent_tool_use_id. SubagentBar rows render them live.
    const fake = makeFakeChild();
    mockedSpawn.mockReturnValue(fake as never);
    const engine = createClaudeCliEngine({ tabId: 't', claudeBinaryPath: '/bin/claude' });

    await engine.start(baseParams);

    const args = mockedSpawn.mock.calls[0]![1] as string[];
    expect(args).toContain('--forward-subagent-text');
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

// ---------------------------------------------------------------------------
// The control channel: sendControlRequest / control_response / can_use_tool.
//
// This is the half of the engine that carries every mid-session setting
// change and every permission prompt, and it was untested. Its failure mode
// is a promise that never settles — the "control_request: reply was never
// sent" hang the pending-request registry exists to prevent.
// ---------------------------------------------------------------------------

/** Start an engine on a fake child and hand back both. */
async function started(params: Record<string, unknown> = {}) {
  const fake = makeFakeChild();
  mockedSpawn.mockReturnValue(fake as never);
  const engine = createClaudeCliEngine({ tabId: 't1', claudeBinaryPath: '/bin/claude' } as never);
  await engine.start({ ...baseParams, ...params } as never);
  /** Feed one NDJSON line in on stdout. */
  const emit = async (obj: unknown) => {
    fake.stdout.push(JSON.stringify(obj) + '\n');
    await flush();
  };
  /** Every JSON line the engine wrote to stdin. */
  const written = () => fake.stdin._writes.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { engine, fake, emit, written };
}

describe('ClaudeCliEngine — control requests', () => {
  it('writes a control_request envelope and settles on the matching response', async () => {
    const { engine, emit, written } = await started();
    const p = engine.sendControlRequest('set_model', { model: 'claude-opus-5' });
    const sent = written().at(-1) as { type: string; request_id: string; request: unknown };
    expect(sent.type).toBe('control_request');
    expect(sent.request).toEqual({ subtype: 'set_model', model: 'claude-opus-5' });

    await emit({
      type: 'control_response',
      response: { subtype: 'success', request_id: sent.request_id, response: { ok: true } },
    });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('rejects with the CLI-supplied text on an error response', async () => {
    const { engine, emit, written } = await started();
    const p = engine.sendControlRequest('set_model', {});
    // Attach the expectation before the rejection lands, or vitest reports
    // the momentarily-unhandled rejection as a suite error.
    const rejected = expect(p).rejects.toThrow('unknown model');
    const id = (written().at(-1) as { request_id: string }).request_id;
    await emit({
      type: 'control_response',
      response: { subtype: 'error', request_id: id, error: 'unknown model' },
    });
    await rejected;
  });

  it('rejects with a fallback when an error response carries no text', async () => {
    const { engine, emit, written } = await started();
    const p = engine.sendControlRequest('set_model', {});
    const rejected = expect(p).rejects.toThrow('unknown control_response error');
    const id = (written().at(-1) as { request_id: string }).request_id;
    await emit({ type: 'control_response', response: { subtype: 'error', request_id: id } });
    await rejected;
  });

  it('omits the params spread when none are supplied', async () => {
    const { engine, written } = await started();
    void engine.sendControlRequest('interrupt').catch(() => {});
    expect((written().at(-1) as { request: unknown }).request).toEqual({ subtype: 'interrupt' });
  });

  it('gives each request a distinct id', async () => {
    const { engine, written } = await started();
    void engine.sendControlRequest('a').catch(() => {});
    void engine.sendControlRequest('b').catch(() => {});
    const ids = written().slice(-2).map((e) => (e as { request_id: string }).request_id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('rejects immediately once the child is gone', async () => {
    const { engine } = await started();
    await engine.close();
    await expect(engine.sendControlRequest('set_model', {})).rejects.toThrow('child not running');
  });

  // The response can never arrive after an exit, so waiting for each
  // request's own timeout would hang the renderer's IPC calls for nothing.
  it('fails every in-flight request when the child exits', async () => {
    const { engine, fake } = await started();
    const p = engine.sendControlRequest('get_context_usage');
    const rejected = expect(p).rejects.toThrow(/engine exited \(code 1, signal SIGTERM\)/);
    fake.emit('exit', 1, 'SIGTERM');
    await flush();
    await rejected;
  });

  it('drives interrupt through the control channel', async () => {
    const { engine, written } = await started();
    void engine.interrupt().catch(() => {});
    expect((written().at(-1) as { request: { subtype: string } }).request.subtype).toBe('interrupt');
  });
});

describe('ClaudeCliEngine — applyExtendedPermissionMode', () => {
  // 'auto' and 'dontAsk' are not accepted by the CLI's argv parser (it exits
  // 1), so they are applied after spawn over the control channel instead.
  it('sends set_permission_mode for a mode argv cannot express', async () => {
    const { engine, written } = await started();
    void engine.applyExtendedPermissionMode('dontAsk');
    await flush();
    expect((written().at(-1) as { request: unknown }).request)
      .toEqual({ subtype: 'set_permission_mode', mode: 'dontAsk' });
  });

  // The four argv-expressible modes were already pinned at spawn; re-sending
  // them would be a redundant round trip.
  it('is a no-op for a mode already pinned on argv', async () => {
    const { engine, written } = await started();
    const before = written().length;
    await engine.applyExtendedPermissionMode('acceptEdits');
    expect(written().length).toBe(before);
  });

  // Non-fatal by design: the CLI keeps whatever mode it defaulted to.
  it('swallows a rejection rather than failing the session start', async () => {
    const { engine, emit, written } = await started();
    const p = engine.applyExtendedPermissionMode('auto');
    await flush();
    const id = (written().at(-1) as { request_id: string }).request_id;
    await emit({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'no' } });
    await expect(p).resolves.toBeUndefined();
  });
});

describe('ClaudeCliEngine — permission requests', () => {
  const canUseTool = (requestId = 'r1', toolUseId = 'toolu_1') => ({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: toolUseId },
  });

  it('routes can_use_tool to permission subscribers, not the transcript', async () => {
    const { engine, emit } = await started();
    const perms: unknown[] = [];
    const msgs: AgentMessage[] = [];
    engine.onPermissionRequest((r) => perms.push(r));
    engine.onMessage((m) => msgs.push(m));
    await emit(canUseTool());
    expect(perms).toHaveLength(1);
    expect(perms[0]).toMatchObject({
      agent: 'claude',
      requestId: 'r1',
      kind: 'tool',
      summary: 'Permission requested for tool: Bash',
    });
    expect(msgs).toHaveLength(0);
  });

  it('names an unknown tool rather than rendering undefined', async () => {
    const { engine, emit } = await started();
    const perms: { summary: string }[] = [];
    engine.onPermissionRequest((r) => perms.push(r as never));
    await emit({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_use_id: 'x' } });
    expect(perms[0].summary).toBe('Permission requested for tool: unknown');
  });

  it('keeps dispatching after one subscriber throws', async () => {
    const { engine, emit } = await started();
    const seen: unknown[] = [];
    engine.onPermissionRequest(() => {
      throw new Error('bad subscriber');
    });
    engine.onPermissionRequest((r) => seen.push(r));
    await emit(canUseTool());
    expect(seen).toHaveLength(1);
  });

  it('stops delivering to a disposed subscriber', async () => {
    const { engine, emit } = await started();
    const seen: unknown[] = [];
    const sub = engine.onPermissionRequest((r) => seen.push(r));
    sub.dispose();
    await emit(canUseTool());
    expect(seen).toHaveLength(0);
  });

  // The CLI matches the decision by toolUseID, which only the original
  // can_use_tool carried — the engine remembers it per request_id.
  it('echoes the remembered toolUseID back on the control_response', async () => {
    const { engine, emit, written } = await started();
    engine.onPermissionRequest(() => {});
    await emit(canUseTool('r1', 'toolu_abc'));
    await engine.respondPermission('r1', 'allow', { updatedInput: { command: 'ls' } });
    const sent = written().at(-1) as { type: string; response: { request_id: string; response: Record<string, unknown> } };
    expect(sent.type).toBe('control_response');
    expect(sent.response.request_id).toBe('r1');
    expect(sent.response.response).toEqual({
      behavior: 'allow',
      toolUseID: 'toolu_abc',
      updatedInput: { command: 'ls' },
    });
  });

  // Re-pinned after the payload spread so a caller can't clobber them.
  it('refuses to let the payload overwrite behavior or toolUseID', async () => {
    const { engine, emit, written } = await started();
    await emit(canUseTool('r1', 'toolu_abc'));
    await engine.respondPermission('r1', 'deny', { behavior: 'allow', toolUseID: 'spoofed' });
    const body = (written().at(-1) as { response: { response: Record<string, unknown> } }).response.response;
    expect(body.behavior).toBe('deny');
    expect(body.toolUseID).toBe('toolu_abc');
  });

  it('sends an empty toolUseID for an unknown request', async () => {
    const { engine, written } = await started();
    await engine.respondPermission('never-seen', 'deny');
    const body = (written().at(-1) as { response: { response: Record<string, unknown> } }).response.response;
    expect(body).toEqual({ behavior: 'deny', toolUseID: '' });
  });

  it('is a silent no-op once the child is gone', async () => {
    const { engine } = await started();
    await engine.close();
    await expect(engine.respondPermission('r1', 'allow')).resolves.toBeUndefined();
  });
});

describe('ClaudeCliEngine — stdin writes and lifecycle', () => {
  it('sends a structured content array verbatim', async () => {
    const { engine, written } = await started();
    const content = [{ type: 'text', text: 'hi' }, { type: 'image', source: {} }];
    await engine.sendStructured(content);
    expect((written().at(-1) as { message: { content: unknown } }).message.content).toEqual(content);
  });

  it('refuses to send once the child is gone', async () => {
    const { engine } = await started();
    await engine.close();
    await expect(engine.send('hi')).rejects.toThrow('child not running');
  });

  it('stamps the session id the CLI reported on later user messages', async () => {
    const { engine, emit, written } = await started();
    await emit({ type: 'system', subtype: 'init', session_id: 'sess-from-cli' });
    await engine.send('hi');
    expect((written().at(-1) as { session_id: string }).session_id).toBe('sess-from-cli');
  });

  // The resume id is pinned from the start params at spawn (that is the whole
  // point of --session-id: the JSONL path is known before the CLI answers),
  // then corrected if the CLI reports a different one on system:init.
  it('starts from the pinned session id and adopts the one the CLI reports', async () => {
    const { engine, emit } = await started();
    expect(engine.getResumeId()).toBe('sess-1');
    await emit({ type: 'system', subtype: 'init', session_id: 'sess-from-cli' });
    expect(engine.getResumeId()).toBe('sess-from-cli');
  });

  it('keeps the pinned id when system:init carries no session_id', async () => {
    const { engine, emit } = await started();
    await emit({ type: 'system', subtype: 'init' });
    expect(engine.getResumeId()).toBe('sess-1');
  });

  it('caches the init catalog for synchronous reads', async () => {
    const { engine, emit } = await started();
    expect(engine.getInitData()).toBeNull();
    await emit({
      type: 'system', subtype: 'init', session_id: 's',
      account: { email: 'a@b.c' }, commands: [{ name: 'commit' }],
      models: [{ id: 'claude-opus-5' }], agents: [{ name: 'Explore' }],
    });
    expect(engine.getInitData()).toEqual({
      account: { email: 'a@b.c' },
      commands: [{ name: 'commit' }],
      models: [{ id: 'claude-opus-5' }],
      agents: [{ name: 'Explore' }],
    });
  });

  it('closes with SIGTERM and kills with SIGKILL', async () => {
    const a = await started();
    await a.engine.close();
    expect(a.fake.kill).toHaveBeenCalledWith('SIGTERM');

    const b = await started();
    b.engine.kill();
    expect(b.fake.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('tolerates close() and kill() on an already-dead child', async () => {
    const { engine, fake } = await started();
    fake.kill.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    await expect(engine.close()).resolves.toBeUndefined();
    expect(() => engine.kill()).not.toThrow();
  });

  it('is idempotent across repeated close and kill', async () => {
    const { engine, fake } = await started();
    await engine.close();
    await engine.close();
    engine.kill();
    expect(fake.kill).toHaveBeenCalledTimes(1);
  });

  it('surfaces a child spawn error to onError subscribers', async () => {
    const { engine, fake } = await started();
    const errs: Error[] = [];
    engine.onError((e) => errs.push(e));
    fake.emit('error', new Error('EPIPE'));
    await flush();
    expect(errs.map((e) => e.message)).toEqual(['EPIPE']);
  });

  it('stops delivering to disposed message and exit subscribers', async () => {
    const { engine, emit, fake } = await started();
    const msgs: unknown[] = [];
    const exits: unknown[] = [];
    engine.onMessage((m) => msgs.push(m)).dispose();
    engine.onExit((i) => exits.push(i)).dispose();
    await emit({ type: 'assistant', message: { role: 'assistant', content: [] } });
    fake.emit('exit', 0, null);
    await flush();
    expect(msgs).toEqual([]);
    expect(exits).toEqual([]);
  });
});

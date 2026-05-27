import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createCodexCliEngine } from '../../services/agents/codex-cli-engine';
import type { AgentPermissionRequest } from '../../services/agents/types';

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
  emitter.pid = 54321;
  // Mirror real spawn — `'spawn'` fires on next tick after the OS exec'd
  // the binary. engine.start() awaits this before sending the handshake.
  setImmediate(() => emitter.emit('spawn'));
  return emitter;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  mockedSpawn.mockReset();
});

describe('CodexCliEngine', () => {
  describe('start() cold-start handshake', () => {
    it('spawns `codex mcp` and sends a newConversation JSON-RPC request', async () => {
      const fake = makeFakeChild();
      mockedSpawn.mockReturnValue(fake as never);

      const engine = createCodexCliEngine({
        tabId: 'tab-x',
        codexBinaryPath: '/usr/local/bin/codex',
      });

      const startPromise = engine.start({
        projectPath: '/p',
        configDir: '/c',
        model: 'gpt-5',
        sessionId: 'session-uuid',
        resume: false,
        codex: { sandboxPolicy: 'workspace-write', reasoningEffort: 'medium' },
      });
      // Catch the pending rejection until we drive the response below — keeps
      // vitest from flagging an "unhandled rejection" if assertions fail.
      startPromise.catch(() => {});

      await flushMicrotasks();

      expect(mockedSpawn).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = mockedSpawn.mock.calls[0] as [
        string,
        string[],
        { cwd: string },
      ];
      expect(cmd).toBe('/usr/local/bin/codex');
      expect(args).toEqual(['mcp']);
      expect(opts.cwd).toBe('/p');

      expect(fake.stdin._writes.length).toBe(1);
      const sent = JSON.parse(fake.stdin._writes[0]!.trim());
      expect(sent.jsonrpc).toBe('2.0');
      expect(typeof sent.id).toBe('number');
      expect(sent.method).toBe('newConversation');
      expect(sent.params).toMatchObject({
        model: 'gpt-5',
        sandboxPolicy: 'workspace-write',
        reasoningEffort: 'medium',
      });

      fake.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          id: sent.id,
          result: { conversationId: 'conv-1' },
        }) + '\n',
      );

      await expect(startPromise).resolves.toBeUndefined();
      expect(engine.getResumeId()).toBe('conv-1');
    });

    it('resume path sends a resumeConversation request with the existing conversationId', async () => {
      const fake = makeFakeChild();
      mockedSpawn.mockReturnValue(fake as never);

      const engine = createCodexCliEngine({
        tabId: 'tab-y',
        codexBinaryPath: '/usr/local/bin/codex',
      });

      const startPromise = engine.start({
        projectPath: '/p',
        configDir: '/c',
        model: 'gpt-5',
        sessionId: 'conv-existing',
        resume: true,
        codex: { sandboxPolicy: 'read-only' },
      });
      startPromise.catch(() => {});

      await flushMicrotasks();

      expect(fake.stdin._writes.length).toBe(1);
      const sent = JSON.parse(fake.stdin._writes[0]!.trim());
      expect(sent.method).toBe('resumeConversation');
      expect(sent.params).toMatchObject({
        conversationId: 'conv-existing',
        sandboxPolicy: 'read-only',
      });

      fake.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          id: sent.id,
          result: { conversationId: 'conv-existing' },
        }) + '\n',
      );

      await expect(startPromise).resolves.toBeUndefined();
      expect(engine.getResumeId()).toBe('conv-existing');
    });

    it('resume falls back to p.sessionId when server omits conversationId', async () => {
      const fake = makeFakeChild();
      mockedSpawn.mockReturnValue(fake as never);

      const engine = createCodexCliEngine({
        tabId: 'tab-z',
        codexBinaryPath: '/usr/local/bin/codex',
      });

      const startPromise = engine.start({
        projectPath: '/p',
        configDir: '/c',
        model: 'gpt-5',
        sessionId: 'conv-existing',
        resume: true,
        codex: { sandboxPolicy: 'read-only' },
      });
      startPromise.catch(() => {});

      await flushMicrotasks();

      const sent = JSON.parse(fake.stdin._writes[0]!.trim());
      expect(sent.method).toBe('resumeConversation');

      // Server replies with an empty result — no conversationId in the
      // response. Engine should fall back to the originally-supplied
      // sessionId so resume identity isn't lost.
      fake.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          id: sent.id,
          result: {},
        }) + '\n',
      );

      await expect(startPromise).resolves.toBeUndefined();
      expect(engine.getResumeId()).toBe('conv-existing');
    });

    it('cold start returns null conversationId when server omits it', async () => {
      const fake = makeFakeChild();
      mockedSpawn.mockReturnValue(fake as never);

      const engine = createCodexCliEngine({
        tabId: 'tab-w',
        codexBinaryPath: '/usr/local/bin/codex',
      });

      const startPromise = engine.start({
        projectPath: '/p',
        configDir: '/c',
        model: 'gpt-5',
        sessionId: 'session-uuid',
        resume: false,
      });
      startPromise.catch(() => {});

      await flushMicrotasks();

      const sent = JSON.parse(fake.stdin._writes[0]!.trim());
      expect(sent.method).toBe('newConversation');

      fake.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          id: sent.id,
          result: {},
        }) + '\n',
      );

      await expect(startPromise).resolves.toBeUndefined();
      expect(engine.getResumeId()).toBeNull();
    });
  });

  describe('send()', () => {
    it('send() writes sendUserTurn JSON-RPC with conversationId + input and resolves on success', async () => {
      const fake = makeFakeChild();
      mockedSpawn.mockReturnValue(fake as never);

      const engine = createCodexCliEngine({
        tabId: 'tab-send',
        codexBinaryPath: '/usr/local/bin/codex',
      });

      const startPromise = engine.start({
        projectPath: '/p',
        configDir: '/c',
        model: 'gpt-5',
        sessionId: 'session-uuid',
        resume: false,
      });
      startPromise.catch(() => {});

      await flushMicrotasks();

      const startSent = JSON.parse(fake.stdin._writes[0]!.trim());
      expect(startSent.method).toBe('newConversation');

      fake.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          id: startSent.id,
          result: { conversationId: 'conv-1' },
        }) + '\n',
      );

      await expect(startPromise).resolves.toBeUndefined();
      expect(engine.getResumeId()).toBe('conv-1');

      const writesBefore = fake.stdin._writes.length;

      const sendPromise = engine.send('hello');
      sendPromise.catch(() => {});

      await flushMicrotasks();

      expect(fake.stdin._writes.length).toBe(writesBefore + 1);
      const sent = JSON.parse(fake.stdin._writes[writesBefore]!.trim());
      expect(sent.jsonrpc).toBe('2.0');
      expect(typeof sent.id).toBe('number');
      expect(sent.method).toBe('sendUserTurn');
      expect(sent.params).toMatchObject({
        conversationId: 'conv-1',
        input: 'hello',
      });

      fake.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          id: sent.id,
          result: {},
        }) + '\n',
      );

      await expect(sendPromise).resolves.toBeUndefined();
    });

    it('send() throws when conversationId is null (start() not yet called or cold-start returned no conversationId)', async () => {
      const fake = makeFakeChild();
      mockedSpawn.mockReturnValue(fake as never);

      const engine = createCodexCliEngine({
        tabId: 'tab-no-conv',
        codexBinaryPath: '/usr/local/bin/codex',
      });

      // start() never called — conversationId stays null. send() should
      // reject loudly rather than silently no-op or write a bogus request.
      await expect(engine.send('hello')).rejects.toThrow(/no active conversation/i);
    });
  });

  describe('approvals (Codex server-initiated)', () => {
    async function bootEngineWithConversation(): Promise<{
      engine: ReturnType<typeof createCodexCliEngine>;
      fake: FakeChild;
    }> {
      const fake = makeFakeChild();
      mockedSpawn.mockReturnValue(fake as never);

      const engine = createCodexCliEngine({
        tabId: 'tab-approve',
        codexBinaryPath: '/usr/local/bin/codex',
      });

      const startPromise = engine.start({
        projectPath: '/p',
        configDir: '/c',
        model: 'gpt-5',
        sessionId: 'session-uuid',
        resume: false,
      });
      startPromise.catch(() => {});

      await flushMicrotasks();

      const startSent = JSON.parse(fake.stdin._writes[0]!.trim());
      fake.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          id: startSent.id,
          result: { conversationId: 'conv-1' },
        }) + '\n',
      );

      await startPromise;
      return { engine, fake };
    }

    it('applyPatchApproval is surfaced as onPermissionRequest with kind=patch', async () => {
      const { engine, fake } = await bootEngineWithConversation();

      const received: AgentPermissionRequest[] = [];
      engine.onPermissionRequest((r) => received.push(r));

      const params = {
        conversationId: 'conv-1',
        callId: 'c1',
        fileChanges: { 'src/foo.ts': { add: ['bar'] } },
        reason: 'edit',
      };
      fake.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'srv-p1',
          method: 'applyPatchApproval',
          params,
        }) + '\n',
      );

      await flushMicrotasks();

      expect(received.length).toBe(1);
      const r = received[0]!;
      expect(r.agent).toBe('codex');
      expect(r.requestId).toBe('srv-p1');
      expect(r.kind).toBe('patch');
      expect(r.summary.toLowerCase()).toContain('patch');
      expect(r.payload).toEqual(params);
    });

    it('execCommandApproval is surfaced as onPermissionRequest with kind=exec', async () => {
      const { engine, fake } = await bootEngineWithConversation();

      const received: AgentPermissionRequest[] = [];
      engine.onPermissionRequest((r) => received.push(r));

      const params = {
        conversationId: 'conv-1',
        callId: 'c2',
        command: 'ls -la',
        cwd: '/tmp',
        reason: 'shell',
      };
      fake.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'srv-e1',
          method: 'execCommandApproval',
          params,
        }) + '\n',
      );

      await flushMicrotasks();

      expect(received.length).toBe(1);
      const r = received[0]!;
      expect(r.agent).toBe('codex');
      expect(r.requestId).toBe('srv-e1');
      expect(r.kind).toBe('exec');
      expect(r.summary).toContain('ls -la');
      expect(r.payload).toEqual(params);
    });

    it('respondPermission writes a JSON-RPC response with allow decision on the matching id', async () => {
      const { engine, fake } = await bootEngineWithConversation();

      engine.onPermissionRequest(() => {});

      fake.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'srv-p1',
          method: 'applyPatchApproval',
          params: {
            conversationId: 'conv-1',
            callId: 'c1',
            fileChanges: {},
          },
        }) + '\n',
      );

      await flushMicrotasks();

      const writesBefore = fake.stdin._writes.length;
      await engine.respondPermission('srv-p1', 'allow');

      expect(fake.stdin._writes.length).toBe(writesBefore + 1);
      const sent = JSON.parse(fake.stdin._writes[writesBefore]!.trim());
      expect(sent).toEqual({
        jsonrpc: '2.0',
        id: 'srv-p1',
        result: { decision: 'allow' },
      });
    });

    it('respondPermission writes a JSON-RPC response with deny decision', async () => {
      const { engine, fake } = await bootEngineWithConversation();

      engine.onPermissionRequest(() => {});

      fake.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'srv-p1',
          method: 'applyPatchApproval',
          params: { conversationId: 'conv-1', callId: 'c1', fileChanges: {} },
        }) + '\n',
      );

      await flushMicrotasks();

      const writesBefore = fake.stdin._writes.length;
      await engine.respondPermission('srv-p1', 'deny');

      expect(fake.stdin._writes.length).toBe(writesBefore + 1);
      const sent = JSON.parse(fake.stdin._writes[writesBefore]!.trim());
      expect(sent).toEqual({
        jsonrpc: '2.0',
        id: 'srv-p1',
        result: { decision: 'deny' },
      });
    });

    it('unknown server-initiated methods respond with method-not-handled error', async () => {
      const { fake } = await bootEngineWithConversation();

      const writesBefore = fake.stdin._writes.length;

      fake.stdout.push(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'srv-x',
          method: 'futureFeature',
          params: {},
        }) + '\n',
      );

      await flushMicrotasks();

      expect(fake.stdin._writes.length).toBe(writesBefore + 1);
      const sent = JSON.parse(fake.stdin._writes[writesBefore]!.trim());
      expect(sent.jsonrpc).toBe('2.0');
      expect(sent.id).toBe('srv-x');
      expect(sent.error?.code).toBe(-32601);
      expect(String(sent.error?.message).toLowerCase()).toMatch(/not handled|unknown/);
    });
  });
});

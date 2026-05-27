import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createCodexCliEngine } from '../../services/agents/codex-cli-engine';

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
});

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

describe('ClaudeCliEngine', () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
  });

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

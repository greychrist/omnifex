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
});

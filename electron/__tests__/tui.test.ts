import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn as ptySpawn } from 'node-pty';
import { createTuiSession } from '../services/sessions/tui';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

const mockedSpawn = vi.mocked(ptySpawn);

function makeFakePty() {
  const listeners: { data: ((s: string) => void)[]; exit: ((r: any) => void)[] } = {
    data: [],
    exit: [],
  };
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (cb: (s: string) => void) => {
      listeners.data.push(cb);
      return { dispose: () => {} };
    },
    onExit: (cb: (r: any) => void) => {
      listeners.exit.push(cb);
      return { dispose: () => {} };
    },
    _emitData: (s: string) => listeners.data.forEach((cb) => cb(s)),
    _emitExit: (r: any) => listeners.exit.forEach((cb) => cb(r)),
  };
}

describe('TuiSession', () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  it('spawns `claude --resume <sessionId>` when resume=true', () => {
    const fake = makeFakePty();
    mockedSpawn.mockReturnValue(fake as any);

    createTuiSession({
      tabId: 't1',
      projectPath: '/Users/test/proj',
      configDir: '/Users/test/.claude-alice',
      sessionId: 'session-abc',
      resume: true,
      claudeBinaryPath: '/usr/local/bin/claude',
    });

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockedSpawn.mock.calls[0];
    expect(cmd).toBe('/usr/local/bin/claude');
    expect(args).toEqual(['--resume', 'session-abc']);
    expect((opts as any).cwd).toBe('/Users/test/proj');
    expect((opts as any).env.CLAUDE_CONFIG_DIR).toBe('/Users/test/.claude-alice');
  });

  it('spawns `claude --session-id <uuid>` when resume=false (cold-start)', () => {
    const fake = makeFakePty();
    mockedSpawn.mockReturnValue(fake as any);

    createTuiSession({
      tabId: 't1b',
      projectPath: '/Users/test/proj',
      configDir: '/Users/test/.claude-alice',
      sessionId: 'aabbccdd-eeff-0011-2233-445566778899',
      resume: false,
      claudeBinaryPath: '/usr/local/bin/claude',
    });

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [, args] = mockedSpawn.mock.calls[0];
    expect(args).toEqual(['--session-id', 'aabbccdd-eeff-0011-2233-445566778899']);
  });

  it('forwards pty data chunks to the onData callback', () => {
    const fake = makeFakePty();
    mockedSpawn.mockReturnValue(fake as any);

    const tui = createTuiSession({
      tabId: 't2', projectPath: '/p', configDir: '/c', sessionId: 's',
      resume: true,
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    const received: string[] = [];
    tui.onData((d) => received.push(d));

    fake._emitData('hello');
    fake._emitData(' world');

    expect(received).toEqual(['hello', ' world']);
  });

  it('forwards pty exit to the onExit callback', () => {
    const fake = makeFakePty();
    mockedSpawn.mockReturnValue(fake as any);

    const tui = createTuiSession({
      tabId: 't3', projectPath: '/p', configDir: '/c', sessionId: 's',
      resume: true,
      claudeBinaryPath: '/usr/local/bin/claude',
    });
    const exits: any[] = [];
    tui.onExit((r) => exits.push(r));

    fake._emitExit({ exitCode: 0 });

    expect(exits).toEqual([{ exitCode: 0 }]);
  });

  it('passes write / resize / kill through to the pty', () => {
    const fake = makeFakePty();
    mockedSpawn.mockReturnValue(fake as any);

    const tui = createTuiSession({
      tabId: 't4', projectPath: '/p', configDir: '/c', sessionId: 's',
      resume: true,
      claudeBinaryPath: '/usr/local/bin/claude',
    });

    tui.write('ls\n');
    tui.resize(120, 40);
    tui.kill();

    expect(fake.write).toHaveBeenCalledWith('ls\n');
    expect(fake.resize).toHaveBeenCalledWith(120, 40);
    expect(fake.kill).toHaveBeenCalled();
  });
});

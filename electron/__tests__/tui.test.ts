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

  it('spawns `claude --resume <sessionId>` in the project cwd with CLAUDE_CONFIG_DIR set', () => {
    const fake = makeFakePty();
    mockedSpawn.mockReturnValue(fake as any);

    createTuiSession({
      tabId: 't1',
      projectPath: '/Users/test/proj',
      configDir: '/Users/test/.claude-alice',
      sessionId: 'session-abc',
      claudeBinaryPath: '/usr/local/bin/claude',
    });

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockedSpawn.mock.calls[0];
    expect(cmd).toBe('/usr/local/bin/claude');
    expect(args).toEqual(['--resume', 'session-abc']);
    expect((opts as any).cwd).toBe('/Users/test/proj');
    expect((opts as any).env.CLAUDE_CONFIG_DIR).toBe('/Users/test/.claude-alice');
  });
});

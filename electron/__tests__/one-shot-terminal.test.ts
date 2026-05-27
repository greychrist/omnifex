// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// node-pty is mocked so tests run under plain Node without a real subprocess.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import { spawn as ptySpawn } from 'node-pty';
import { createOneShotTerminalService } from '../services/one-shot-terminal';

interface FakePty {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onData: (cb: (data: string) => void) => { dispose: () => void };
  onExit: (cb: (info: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
  /** Test-only — fire a data chunk to subscribers. */
  __emitData(data: string): void;
  /** Test-only — fire an exit event to subscribers. */
  __emitExit(info: { exitCode: number; signal?: number }): void;
}

function makeFakePty(): FakePty {
  const dataCbs: ((data: string) => void)[] = [];
  const exitCbs: ((info: { exitCode: number; signal?: number }) => void)[] = [];
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (cb) => {
      dataCbs.push(cb);
      return { dispose: () => { dataCbs.splice(dataCbs.indexOf(cb), 1); } };
    },
    onExit: (cb) => {
      exitCbs.push(cb);
      return { dispose: () => { exitCbs.splice(exitCbs.indexOf(cb), 1); } };
    },
    __emitData(data) { for (const cb of [...dataCbs]) cb(data); },
    __emitExit(info) { for (const cb of [...exitCbs]) cb(info); },
  };
}

beforeEach(() => {
  vi.mocked(ptySpawn).mockReset();
});

describe('createOneShotTerminalService', () => {
  it('spawn() returns a unique handle and forwards binary/args/cwd/env/cols/rows to node-pty', () => {
    const pty = makeFakePty();
    vi.mocked(ptySpawn).mockReturnValue(pty as any);

    const service = createOneShotTerminalService();
    const handle = service.spawn({
      binary: '/usr/local/bin/codex',
      args: ['login'],
      env: { FOO: 'bar' },
      cwd: '/tmp/x',
      cols: 100,
      rows: 30,
    });

    expect(handle.ptyHandle).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = vi.mocked(ptySpawn).mock.calls[0];
    expect(bin).toBe('/usr/local/bin/codex');
    expect(args).toEqual(['login']);
    expect(opts).toMatchObject({ cwd: '/tmp/x', cols: 100, rows: 30 });
    expect((opts as any).env).toMatchObject({ FOO: 'bar' });
  });

  it('defaults cols=80 rows=24 when not provided', () => {
    const pty = makeFakePty();
    vi.mocked(ptySpawn).mockReturnValue(pty as any);

    const service = createOneShotTerminalService();
    service.spawn({ binary: 'codex', args: [] });

    const [, , opts] = vi.mocked(ptySpawn).mock.calls[0];
    expect(opts).toMatchObject({ cols: 80, rows: 24 });
  });

  it('produces a different handle per spawn', () => {
    vi.mocked(ptySpawn).mockImplementation(() => makeFakePty() as any);
    const service = createOneShotTerminalService();
    const a = service.spawn({ binary: 'codex', args: [] });
    const b = service.spawn({ binary: 'codex', args: [] });
    expect(a.ptyHandle).not.toBe(b.ptyHandle);
  });

  it('write(handle, data) forwards to the matching pty', () => {
    const pty = makeFakePty();
    vi.mocked(ptySpawn).mockReturnValue(pty as any);

    const service = createOneShotTerminalService();
    const { ptyHandle } = service.spawn({ binary: 'codex', args: [] });
    service.write(ptyHandle, 'hello');
    expect(pty.write).toHaveBeenCalledWith('hello');
  });

  it('resize(handle, cols, rows) forwards to the matching pty', () => {
    const pty = makeFakePty();
    vi.mocked(ptySpawn).mockReturnValue(pty as any);

    const service = createOneShotTerminalService();
    const { ptyHandle } = service.spawn({ binary: 'codex', args: [] });
    service.resize(ptyHandle, 120, 40);
    expect(pty.resize).toHaveBeenCalledWith(120, 40);
  });

  it('kill(handle) calls pty.kill and makes subsequent write/resize/kill no-ops', () => {
    const pty = makeFakePty();
    vi.mocked(ptySpawn).mockReturnValue(pty as any);

    const service = createOneShotTerminalService();
    const { ptyHandle } = service.spawn({ binary: 'codex', args: [] });
    service.kill(ptyHandle);
    expect(pty.kill).toHaveBeenCalledTimes(1);

    // After kill the handle is gone — these must NOT throw and must NOT
    // re-invoke the dead pty.
    service.write(ptyHandle, 'late');
    service.resize(ptyHandle, 1, 1);
    service.kill(ptyHandle);
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.resize).not.toHaveBeenCalled();
    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it('write/resize/kill on an unknown handle are no-ops (no throw)', () => {
    const service = createOneShotTerminalService();
    expect(() => service.write('does-not-exist', 'x')).not.toThrow();
    expect(() => service.resize('does-not-exist', 10, 10)).not.toThrow();
    expect(() => service.kill('does-not-exist')).not.toThrow();
  });

  it('onData() subscribers receive data emitted by the pty', () => {
    const pty = makeFakePty();
    vi.mocked(ptySpawn).mockReturnValue(pty as any);

    const service = createOneShotTerminalService();
    const { ptyHandle } = service.spawn({ binary: 'codex', args: [] });

    const cb = vi.fn();
    const sub = service.onData(ptyHandle, cb);

    pty.__emitData('chunk-1');
    pty.__emitData('chunk-2');
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(1, 'chunk-1');
    expect(cb).toHaveBeenNthCalledWith(2, 'chunk-2');

    // Dispose stops further callbacks.
    sub.dispose();
    pty.__emitData('chunk-3');
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('onExit() subscribers fire exactly once with the exit info', () => {
    const pty = makeFakePty();
    vi.mocked(ptySpawn).mockReturnValue(pty as any);

    const service = createOneShotTerminalService();
    const { ptyHandle } = service.spawn({ binary: 'codex', args: [] });

    const cb = vi.fn();
    service.onExit(ptyHandle, cb);
    pty.__emitExit({ exitCode: 0 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ exitCode: 0 });
  });

  it('after exit, the handle is cleaned up so write/resize are no-ops', () => {
    const pty = makeFakePty();
    vi.mocked(ptySpawn).mockReturnValue(pty as any);

    const service = createOneShotTerminalService();
    const { ptyHandle } = service.spawn({ binary: 'codex', args: [] });
    pty.__emitExit({ exitCode: 0 });

    service.write(ptyHandle, 'late');
    service.resize(ptyHandle, 1, 1);
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.resize).not.toHaveBeenCalled();
  });

  it('multiple spawns route data independently by handle', () => {
    const ptyA = makeFakePty();
    const ptyB = makeFakePty();
    vi.mocked(ptySpawn)
      .mockReturnValueOnce(ptyA as any)
      .mockReturnValueOnce(ptyB as any);

    const service = createOneShotTerminalService();
    const a = service.spawn({ binary: 'codex', args: [] });
    const b = service.spawn({ binary: 'codex', args: [] });

    const cbA = vi.fn();
    const cbB = vi.fn();
    service.onData(a.ptyHandle, cbA);
    service.onData(b.ptyHandle, cbB);

    ptyA.__emitData('aaa');
    ptyB.__emitData('bbb');
    expect(cbA).toHaveBeenCalledWith('aaa');
    expect(cbA).not.toHaveBeenCalledWith('bbb');
    expect(cbB).toHaveBeenCalledWith('bbb');
    expect(cbB).not.toHaveBeenCalledWith('aaa');

    service.write(a.ptyHandle, 'to-a');
    service.write(b.ptyHandle, 'to-b');
    expect(ptyA.write).toHaveBeenCalledWith('to-a');
    expect(ptyA.write).not.toHaveBeenCalledWith('to-b');
    expect(ptyB.write).toHaveBeenCalledWith('to-b');
    expect(ptyB.write).not.toHaveBeenCalledWith('to-a');
  });
});

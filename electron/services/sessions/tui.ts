import { spawn as ptySpawn, type IPty } from 'node-pty';

export interface TuiSessionParams {
  tabId: string;
  projectPath: string;
  configDir: string;
  sessionId: string;
  claudeBinaryPath: string;
  cols?: number;
  rows?: number;
}

export interface TuiSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: { exitCode: number; signal?: number }) => void): void;
}

export function createTuiSession(params: TuiSessionParams): TuiSession {
  const pty: IPty = ptySpawn(
    params.claudeBinaryPath,
    ['--resume', params.sessionId],
    {
      cwd: params.projectPath,
      env: { ...process.env, CLAUDE_CONFIG_DIR: params.configDir },
      cols: params.cols ?? 80,
      rows: params.rows ?? 24,
    }
  );

  return {
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => pty.kill(),
    onData: (cb) => { pty.onData(cb); },
    onExit: (cb) => { pty.onExit(cb); },
  };
}

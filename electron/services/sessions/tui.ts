import { spawn as ptySpawn, type IPty } from 'node-pty';
import { buildClaudeEnv } from '../util/claude-env';

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
      // buildClaudeEnv throws on empty/~-resolving-to-~/.claude configDir.
      env: buildClaudeEnv(params.configDir) as { [k: string]: string },
      cols: params.cols ?? 80,
      rows: params.rows ?? 24,
    }
  );

  const disposables: import('node-pty').IDisposable[] = [];

  return {
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => {
      for (const d of disposables) {
        // eslint-disable-next-line no-empty -- empty block intentional (no-op cleanup / placeholder).
        try { d.dispose(); } catch {}
      }
      disposables.length = 0;
      pty.kill();
    },
    onData: (cb) => { disposables.push(pty.onData(cb)); },
    onExit: (cb) => { disposables.push(pty.onExit(cb)); },
  };
}

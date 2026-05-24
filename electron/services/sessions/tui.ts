import { spawn as ptySpawn, type IPty } from 'node-pty';
import { buildClaudeEnv } from '../util/claude-env';

export interface TuiSessionParams {
  tabId: string;
  projectPath: string;
  configDir: string;
  /** UUID for the session. Required — cold-start callers generate one
   *  via crypto.randomUUID() and pass `resume: false`; mid-session toggle
   *  callers pass the existing sessionId with `resume: true`. */
  sessionId: string;
  /** When true, spawn with `--resume <sessionId>` (continue existing).
   *  When false, spawn with `--session-id <sessionId>` (create new with
   *  the supplied UUID). The latter avoids the CLI's interactive resume
   *  picker that was causing cold-start timeouts. */
  resume: boolean;
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
  const flag = params.resume ? '--resume' : '--session-id';
  const args = [flag, params.sessionId];
  const pty: IPty = ptySpawn(
    params.claudeBinaryPath,
    args,
    {
      cwd: params.projectPath,
      // buildClaudeEnv throws on empty/~-resolving-to-~/.claude configDir.
      env: buildClaudeEnv(params.configDir),
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

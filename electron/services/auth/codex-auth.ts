/**
 * CodexAuthService — backend for Codex authentication.
 *
 * Codex stores its auth in `~/.codex/auth.json`. There are two ways the user
 * can authenticate:
 *
 *  - OAuth: the user ran `codex login` and the resulting JSON holds an id
 *    token plus (sometimes) the account email. We surface that file as
 *    mode='oauth'.
 *  - API key: the user exported `OPENAI_API_KEY` in their shell. Codex picks
 *    it up at spawn time, no on-disk state. We surface that as mode='apikey'
 *    when the file is absent (or unreadable).
 *
 * `getStatus()` answers "is the user signed in right now and how?". The
 * watcher fires when `~/.codex/auth.json` changes so the UI can re-render
 * without polling. `startLoginFlow()` spawns `codex login` via the
 * OneShotTerminal so the renderer can display it in an xterm modal — same
 * pattern Task 13 set up. `cancelLoginFlow()` just kills that pty.
 *
 * Anything touching the user's real auth file is hidden behind injected
 * dependencies (`authFilePath`, `readEnv`, `resolveCodexBinary`) so tests can
 * run against a tmpdir without poking the real config.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSystemCodexBinary } from '../sessions/binary';
import type { OneShotTerminalService } from '../one-shot-terminal';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CodexAuthStatus {
  authenticated: boolean;
  email?: string;
  mode?: 'oauth' | 'apikey';
}

export interface CodexAuthService {
  getStatus(): Promise<CodexAuthStatus>;
  /** Subscribe to auth-file changes. Debounced ~250ms. */
  watch(cb: (status: CodexAuthStatus) => void): { dispose(): void };
  /** Spawn `codex login` via OneShotTerminal. Returns the handle for the renderer to attach. */
  startLoginFlow(opts?: { codexBinaryPath?: string }): Promise<{ ptyHandle: string }>;
  /** Cancel an in-flight login (kills the pty). */
  cancelLoginFlow(ptyHandle: string): void;
}

export interface CreateCodexAuthServiceDeps {
  oneShotTerminal: OneShotTerminalService;
  /** Override for tests; defaults to ~/.codex/auth.json */
  authFilePath?: string;
  /** Override for tests; defaults to process.env */
  readEnv?: () => NodeJS.ProcessEnv;
  /** Override for tests; defaults to findSystemCodexBinary */
  resolveCodexBinary?: () => string | null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const WATCH_DEBOUNCE_MS = 250;

/**
 * Pull an email out of whatever shape Codex happens to use. The CLI has
 * shifted format across versions (top-level `email`, `account_email`, nested
 * `account.email`, …), so we probe several common shapes and return the
 * first match. Missing-everything → undefined; the caller still treats the
 * presence of the file as authenticated.
 */
function extractEmail(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;

  // Flat candidates.
  for (const key of ['email', 'account_email', 'user_email']) {
    const v = obj[key];
    if (typeof v === 'string' && v.includes('@')) return v;
  }

  // Nested account.email — Codex's most recent shape at time of writing.
  const account = obj['account'];
  if (account && typeof account === 'object') {
    const email = (account as Record<string, unknown>).email;
    if (typeof email === 'string' && email.includes('@')) return email;
  }

  // Some versions stash account info under `tokens` claims. Best-effort.
  const tokens = obj['tokens'];
  if (tokens && typeof tokens === 'object') {
    const email = (tokens as Record<string, unknown>).email;
    if (typeof email === 'string' && email.includes('@')) return email;
  }

  return undefined;
}

function defaultAuthFilePath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCodexAuthService(deps: CreateCodexAuthServiceDeps): CodexAuthService {
  const authFilePath = deps.authFilePath ?? defaultAuthFilePath();
  const readEnv = deps.readEnv ?? (() => process.env);
  const resolveCodexBinary = deps.resolveCodexBinary ?? findSystemCodexBinary;

  async function getStatus(): Promise<CodexAuthStatus> {
    // Try the on-disk OAuth file first. Anything goes wrong (missing, perms,
    // bad JSON) → null, then we check the env-key fallback.
    let parsed: unknown = null;
    let fileExists = false;
    try {
      const raw = fs.readFileSync(authFilePath, 'utf8');
      fileExists = true;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // File present but unreadable — treat the same as "no file" for
        // status purposes. The user can recover by running `codex login`
        // again or exporting OPENAI_API_KEY.
        parsed = null;
        fileExists = false;
      }
    } catch {
      // File missing / unreadable.
    }

    if (fileExists && parsed) {
      const email = extractEmail(parsed);
      if (email) return { authenticated: true, mode: 'oauth', email };
      return { authenticated: true, mode: 'oauth' };
    }

    // Fall back to env-key mode.
    const env = readEnv();
    const key = env.OPENAI_API_KEY;
    if (typeof key === 'string' && key.length > 0) {
      return { authenticated: true, mode: 'apikey' };
    }

    return { authenticated: false };
  }

  function watch(cb: (status: CodexAuthStatus) => void): { dispose(): void } {
    // We watch the parent directory rather than the file directly: Codex
    // rewrites auth.json atomically (write tmp + rename), which detaches
    // a file-targeted watcher. Watching the directory and filtering by
    // filename survives that.
    const watchDir = path.dirname(authFilePath);
    const watchName = path.basename(authFilePath);

    let debounceTimer: NodeJS.Timeout | null = null;
    let disposed = false;
    let watcher: fs.FSWatcher | null = null;

    const fire = (): void => {
      if (disposed) return;
      getStatus()
        .then((status) => {
          if (disposed) return;
          try {
            cb(status);
          } catch {
            // A bad subscriber must not kill the watcher.
          }
        })
        .catch(() => {
          // getStatus swallows fs errors internally; we double-guard here.
        });
    };

    const scheduleFire = (): void => {
      if (disposed) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        fire();
      }, WATCH_DEBOUNCE_MS);
    };

    try {
      // Ensure the directory exists so fs.watch has something to attach to.
      // Missing-on-startup is normal — the user may not have run `codex login`
      // yet — so we mkdir -p and proceed. If we can't even create the dir
      // (perms / readonly fs), we silently noop the watcher; the dispose()
      // contract is still honoured.
      try {
        fs.mkdirSync(watchDir, { recursive: true });
      } catch {
        // best-effort; fs.watch below will throw and we'll exit cleanly.
      }
      watcher = fs.watch(watchDir, (_eventType, filename) => {
        if (disposed) return;
        // Some platforms report `filename = null`. Be permissive — any change
        // to the directory triggers a re-check; the debounce makes that
        // affordable.
        if (filename && filename.toString() !== watchName) return;
        scheduleFire();
      });
      watcher.on('error', () => {
        // Same idea — never throw out of the watcher; just drop it.
        if (watcher) {
          try { watcher.close(); } catch { /* best-effort */ }
        }
        watcher = null;
      });
    } catch {
      // fs.watch failed (directory missing on some platforms even after
      // mkdir, fs limits, etc.). Return a noop disposable.
      watcher = null;
    }

    return {
      dispose(): void {
        if (disposed) return;
        disposed = true;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        if (watcher) {
          try { watcher.close(); } catch { /* best-effort */ }
          watcher = null;
        }
      },
    };
  }

  async function startLoginFlow(opts?: { codexBinaryPath?: string }): Promise<{ ptyHandle: string }> {
    const binary = opts?.codexBinaryPath ?? resolveCodexBinary();
    if (!binary) {
      throw new Error(
        'codex binary not found. Install codex (https://github.com/openai/codex) or set a custom path in OmniFex settings.',
      );
    }

    const handle = deps.oneShotTerminal.spawn({
      binary,
      args: ['login'],
      // Codex stores `~/.codex/auth.json` based on $HOME, so we don't need
      // to override cwd; let the user's home dir be the cwd.
      cwd: os.homedir(),
    });

    return { ptyHandle: handle.ptyHandle };
  }

  function cancelLoginFlow(ptyHandle: string): void {
    deps.oneShotTerminal.kill(ptyHandle);
  }

  return {
    getStatus,
    watch,
    startLoginFlow,
    cancelLoginFlow,
  };
}

/**
 * CodexAuthService — backend for Codex authentication.
 *
 * Codex stores its auth in `<CODEX_HOME>/auth.json`. With multi-account Codex
 * support every method is keyed by the account's `configDir` (its CODEX_HOME),
 * so two Codex accounts authenticate independently. There are two ways the
 * user can authenticate:
 *
 *  - OAuth: the user ran `codex login` and the resulting JSON holds an id
 *    token plus (sometimes) the account email. We surface that file as
 *    mode='oauth'.
 *  - API key: the user exported `OPENAI_API_KEY` in their shell. Codex picks
 *    it up at spawn time, no on-disk state. We surface that as mode='apikey'
 *    when the file is absent. NB: OPENAI_API_KEY is machine-wide, so every
 *    Codex account reads as authenticated in apikey mode when it's set.
 *
 * `getStatus(configDir)` answers "is this account signed in right now and
 * how?". `watch(configDir, cb)` fires when that account's `auth.json` changes
 * so the UI can re-render without polling; watchers are refcounted per
 * configDir. `startLoginFlow({ configDir })` spawns `codex login` with
 * `CODEX_HOME=configDir` so the resulting auth file lands in the right account
 * dir.
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
  getStatus(configDir: string): Promise<CodexAuthStatus>;
  /** Subscribe to a single account's auth-file changes. Debounced ~250ms.
   *  Watchers are shared + refcounted per configDir. */
  watch(configDir: string, cb: (status: CodexAuthStatus) => void): { dispose(): void };
  /** Spawn `codex login` via OneShotTerminal with CODEX_HOME=configDir. */
  startLoginFlow(opts: { configDir: string; codexBinaryPath?: string }): Promise<{ ptyHandle: string }>;
  /** Cancel an in-flight login (kills the pty). */
  cancelLoginFlow(ptyHandle: string): void;
  /**
   * Resolve the system-installed `codex` binary path. Returns `null` when
   * the binary isn't on the user's machine.
   */
  getBinaryPath(): string | null;
  /**
   * Sign the account out by removing `<configDir>/auth.json`. Idempotent — a
   * missing file is treated as success. The file watcher picks up the deletion
   * and broadcasts the new unauthenticated status.
   *
   * Note: this does NOT touch `OPENAI_API_KEY`.
   */
  logout(configDir: string): Promise<void>;
}

export interface CreateCodexAuthServiceDeps {
  oneShotTerminal: OneShotTerminalService;
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

  for (const key of ['email', 'account_email', 'user_email']) {
    const v = obj[key];
    if (typeof v === 'string' && v.includes('@')) return v;
  }

  const account = obj['account'];
  if (account && typeof account === 'object') {
    const email = (account as Record<string, unknown>).email;
    if (typeof email === 'string' && email.includes('@')) return email;
  }

  const tokens = obj['tokens'];
  if (tokens && typeof tokens === 'object') {
    const email = (tokens as Record<string, unknown>).email;
    if (typeof email === 'string' && email.includes('@')) return email;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface WatcherSlot {
  fsWatcher: fs.FSWatcher | null;
  subscribers: Set<(s: CodexAuthStatus) => void>;
  debounceTimer: NodeJS.Timeout | null;
}

export function createCodexAuthService(deps: CreateCodexAuthServiceDeps): CodexAuthService {
  const readEnv = deps.readEnv ?? (() => process.env);
  const resolveCodexBinary = deps.resolveCodexBinary ?? findSystemCodexBinary;

  const watchers = new Map<string, WatcherSlot>();

  function authFilePath(configDir: string): string {
    return path.join(configDir, 'auth.json');
  }

  async function getStatus(configDir: string): Promise<CodexAuthStatus> {
    let parsed: unknown = null;
    let fileExists = false;
    try {
      const raw = fs.readFileSync(authFilePath(configDir), 'utf8');
      fileExists = true;
      try {
        parsed = JSON.parse(raw);
      } catch {
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

    const env = readEnv();
    const key = env.OPENAI_API_KEY;
    if (typeof key === 'string' && key.length > 0) {
      return { authenticated: true, mode: 'apikey' };
    }

    return { authenticated: false };
  }

  function attachWatcher(configDir: string, slot: WatcherSlot): void {
    // Watch the parent directory rather than the file: Codex rewrites
    // auth.json atomically (write tmp + rename), which detaches a
    // file-targeted watcher. Watching the dir and filtering by name survives.
    const watchName = 'auth.json';

    const fire = (): void => {
      getStatus(configDir)
        .then((status) => {
          for (const cb of [...slot.subscribers]) {
            try {
              cb(status);
            } catch {
              // A bad subscriber must not kill the watcher.
            }
          }
        })
        .catch(() => {
          // getStatus swallows fs errors internally; double-guard here.
        });
    };

    const scheduleFire = (): void => {
      if (slot.debounceTimer) clearTimeout(slot.debounceTimer);
      slot.debounceTimer = setTimeout(() => {
        slot.debounceTimer = null;
        fire();
      }, WATCH_DEBOUNCE_MS);
    };

    try {
      try {
        fs.mkdirSync(configDir, { recursive: true });
      } catch {
        // best-effort; fs.watch below will throw and we'll exit cleanly.
      }
      const watcher = fs.watch(configDir, (_eventType, filename) => {
        if (filename && filename.toString() !== watchName) return;
        scheduleFire();
      });
      watcher.on('error', () => {
        try { watcher.close(); } catch { /* best-effort */ }
        slot.fsWatcher = null;
      });
      slot.fsWatcher = watcher;
    } catch {
      slot.fsWatcher = null;
    }
  }

  function watch(configDir: string, cb: (s: CodexAuthStatus) => void): { dispose(): void } {
    let slot = watchers.get(configDir);
    if (!slot) {
      slot = { fsWatcher: null, subscribers: new Set(), debounceTimer: null };
      watchers.set(configDir, slot);
      attachWatcher(configDir, slot);
    }
    slot.subscribers.add(cb);

    let disposed = false;
    return {
      dispose(): void {
        if (disposed) return;
        disposed = true;
        const cur = watchers.get(configDir);
        if (!cur) return;
        cur.subscribers.delete(cb);
        if (cur.subscribers.size === 0) {
          if (cur.fsWatcher) {
            try { cur.fsWatcher.close(); } catch { /* best-effort */ }
          }
          if (cur.debounceTimer) clearTimeout(cur.debounceTimer);
          watchers.delete(configDir);
        }
      },
    };
  }

  async function startLoginFlow(opts: {
    configDir: string;
    codexBinaryPath?: string;
  }): Promise<{ ptyHandle: string }> {
    const binary = opts.codexBinaryPath ?? resolveCodexBinary();
    if (!binary) {
      throw new Error(
        'codex binary not found. Install codex (https://github.com/openai/codex) or set a custom path in OmniFex settings.',
      );
    }

    const handle = deps.oneShotTerminal.spawn({
      binary,
      args: ['login'],
      cwd: os.homedir(),
      // CODEX_HOME directs `codex login` to write auth.json into this
      // account's config dir rather than the default ~/.codex.
      env: { ...readEnv(), CODEX_HOME: opts.configDir },
    });

    return { ptyHandle: handle.ptyHandle };
  }

  function cancelLoginFlow(ptyHandle: string): void {
    deps.oneShotTerminal.kill(ptyHandle);
  }

  function getBinaryPath(): string | null {
    return resolveCodexBinary();
  }

  async function logout(configDir: string): Promise<void> {
    try {
      fs.unlinkSync(authFilePath(configDir));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return; // already signed out
      throw err;
    }
  }

  return {
    getStatus,
    watch,
    startLoginFlow,
    cancelLoginFlow,
    getBinaryPath,
    logout,
  };
}

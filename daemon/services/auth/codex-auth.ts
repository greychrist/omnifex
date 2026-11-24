// OPENAI_API_KEY is machine-wide: when set, every Codex account reads as authenticated.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSystemCodexBinary } from '../sessions/binary';
import type { OneShotTerminalService } from '../one-shot-terminal';

export interface CodexAuthStatus {
  authenticated: boolean;
  email?: string;
  mode?: 'oauth' | 'apikey';
}

export interface CodexAuthService {
  getStatus(configDir: string): Promise<CodexAuthStatus>;
  watch(configDir: string, cb: (status: CodexAuthStatus) => void): { dispose(): void };
  startLoginFlow(opts: { configDir: string; codexBinaryPath?: string }): Promise<{ ptyHandle: string }>;
  cancelLoginFlow(ptyHandle: string): void;
  getBinaryPath(): string | null;
  logout(configDir: string): Promise<void>;
}

export interface CreateCodexAuthServiceDeps {
  oneShotTerminal: OneShotTerminalService;
  readEnv?: () => NodeJS.ProcessEnv;
  resolveCodexBinary?: () => string | null;
}

const WATCH_DEBOUNCE_MS = 250;

/** Codex's auth.json shape has shifted across versions, so several are probed. */
function extractEmail(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;

  for (const key of ['email', 'account_email', 'user_email']) {
    const v = obj[key];
    if (typeof v === 'string' && v.includes('@')) return v;
  }

  const account = obj.account;
  if (account && typeof account === 'object') {
    const email = (account as Record<string, unknown>).email;
    if (typeof email === 'string' && email.includes('@')) return email;
  }

  const tokens = obj.tokens;
  if (tokens && typeof tokens === 'object') {
    const email = (tokens as Record<string, unknown>).email;
    if (typeof email === 'string' && email.includes('@')) return email;
  }

  return undefined;
}

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
    // Watch the dir: Codex rewrites auth.json by rename, which detaches a file watcher.
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
      if (e.code === 'ENOENT') return;
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

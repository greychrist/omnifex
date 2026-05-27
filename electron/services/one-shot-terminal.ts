/**
 * One-shot terminal service.
 *
 * Owns short-lived pty subprocesses driven by an xterm modal in the renderer
 * (e.g. `codex login`). Lifecycle is "spawn → user interacts → process exits
 * or the renderer kills it on unmount", not the long-running session model
 * in `electron/services/sessions/`. Each spawn returns an opaque handle that
 * the renderer uses for all subsequent write/resize/kill calls and to
 * subscribe to data/exit events.
 *
 * This file deliberately mirrors the tui.ts pty wiring so any behavioural
 * fixes there port straight across.
 */

import { spawn as ptySpawn, type IPty, type IDisposable } from 'node-pty';
import { randomUUID } from 'node:crypto';

export interface OneShotTerminalSpawnOpts {
  binary: string;
  args: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface OneShotTerminalHandle {
  /** Opaque handle id used by renderer to address this pty. */
  ptyHandle: string;
}

export interface OneShotTerminalService {
  spawn(opts: OneShotTerminalSpawnOpts): OneShotTerminalHandle;
  write(ptyHandle: string, data: string): void;
  resize(ptyHandle: string, cols: number, rows: number): void;
  kill(ptyHandle: string): void;
  /** Subscribe to data on this pty. Returns a Disposable. */
  onData(ptyHandle: string, cb: (data: string) => void): { dispose(): void };
  /** Subscribe to exit on this pty. Returns a Disposable. */
  onExit(
    ptyHandle: string,
    cb: (info: { exitCode: number; signal?: number }) => void,
  ): { dispose(): void };
}

interface Entry {
  pty: IPty;
  disposables: IDisposable[];
  // We keep the cb arrays explicitly (instead of layering on pty.onData per
  // subscriber) so cleanup on exit is O(1) and we can detach all of them
  // when the handle drops out of the map.
  dataCbs: Set<(data: string) => void>;
  exitCbs: Set<(info: { exitCode: number; signal?: number }) => void>;
}

export function createOneShotTerminalService(): OneShotTerminalService {
  const entries = new Map<string, Entry>();

  function cleanup(handle: string): void {
    const entry = entries.get(handle);
    if (!entry) return;
    for (const d of entry.disposables) {
      // eslint-disable-next-line no-empty -- defensive: pty dispose can throw if already disposed.
      try { d.dispose(); } catch {}
    }
    entry.disposables.length = 0;
    entry.dataCbs.clear();
    entry.exitCbs.clear();
    entries.delete(handle);
  }

  return {
    spawn(opts: OneShotTerminalSpawnOpts): OneShotTerminalHandle {
      const handle = randomUUID();
      // node-pty wants a defined env; pass-through is fine but we drop
      // undefined values so the child doesn't see literal "undefined" strings.
      const env: Record<string, string> | undefined = opts.env
        ? Object.fromEntries(
            Object.entries(opts.env).filter(([, v]) => typeof v === 'string'),
          ) as Record<string, string>
        : undefined;

      const pty = ptySpawn(opts.binary, opts.args, {
        cwd: opts.cwd,
        env,
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
      });

      const entry: Entry = {
        pty,
        disposables: [],
        dataCbs: new Set(),
        exitCbs: new Set(),
      };
      entries.set(handle, entry);

      entry.disposables.push(
        pty.onData((data) => {
          // Snapshot before iterating — handlers may dispose themselves.
          for (const cb of [...entry.dataCbs]) {
            // eslint-disable-next-line no-empty -- one bad subscriber must not break the others.
            try { cb(data); } catch {}
          }
        }),
      );
      entry.disposables.push(
        pty.onExit((info) => {
          const snapshot = [...entry.exitCbs];
          // Tear down before firing so subscribers can't accidentally
          // write/resize a dead pty in their handler.
          cleanup(handle);
          for (const cb of snapshot) {
            // eslint-disable-next-line no-empty
            try { cb(info); } catch {}
          }
        }),
      );

      return { ptyHandle: handle };
    },

    write(ptyHandle: string, data: string): void {
      const entry = entries.get(ptyHandle);
      if (!entry) return;
      entry.pty.write(data);
    },

    resize(ptyHandle: string, cols: number, rows: number): void {
      const entry = entries.get(ptyHandle);
      if (!entry) return;
      entry.pty.resize(cols, rows);
    },

    kill(ptyHandle: string): void {
      const entry = entries.get(ptyHandle);
      if (!entry) return;
      // Remove from the map BEFORE pty.kill() so the onExit handler's
      // cleanup is a no-op (already gone) and concurrent write/resize/kill
      // calls from the renderer can't race a half-torn-down entry.
      entries.delete(ptyHandle);
      for (const d of entry.disposables) {
        // eslint-disable-next-line no-empty
        try { d.dispose(); } catch {}
      }
      entry.disposables.length = 0;
      entry.dataCbs.clear();
      entry.exitCbs.clear();
      // eslint-disable-next-line no-empty -- pty.kill() can throw if the child is already gone.
      try { entry.pty.kill(); } catch {}
    },

    onData(ptyHandle: string, cb: (data: string) => void): { dispose(): void } {
      const entry = entries.get(ptyHandle);
      if (!entry) return { dispose: () => { /* no-op */ } };
      entry.dataCbs.add(cb);
      return {
        dispose: () => {
          const cur = entries.get(ptyHandle);
          cur?.dataCbs.delete(cb);
        },
      };
    },

    onExit(
      ptyHandle: string,
      cb: (info: { exitCode: number; signal?: number }) => void,
    ): { dispose(): void } {
      const entry = entries.get(ptyHandle);
      if (!entry) return { dispose: () => { /* no-op */ } };
      entry.exitCbs.add(cb);
      return {
        dispose: () => {
          const cur = entries.get(ptyHandle);
          cur?.exitCbs.delete(cb);
        },
      };
    },
  };
}

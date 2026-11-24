import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { api } from '@/lib/api';
import type { JSX } from 'react';

interface OneShotTerminalProps {
  binary?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  watchPath?: string;
  onWatchFire?: (path: string) => void;
  onExit?: (info: { exitCode: number; signal?: number }) => void;
  /** Captured at mount; must resolve to a one-shot pty handle. */
  spawn?: (size: { cols: number; rows: number }) => Promise<{ ptyHandle: string }>;
  onCancel?: () => void;
  className?: string;
}

const POLL_INTERVAL_MS = 250;

export function OneShotTerminal({
  binary,
  args = [],
  spawn,
  env,
  cwd,
  watchPath,
  onWatchFire,
  onExit,
  className,
}: OneShotTerminalProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  // Refs, so the once-per-mount spawn effect sees fresh callbacks without re-spawning the pty.
  const onExitRef = useRef(onExit);
  const onWatchFireRef = useRef(onWatchFire);
  const spawnRef = useRef(spawn);
  onExitRef.current = onExit;
  onWatchFireRef.current = onWatchFire;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const styles = getComputedStyle(document.documentElement);
    const cssVar = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;

    const term = new Terminal({
      fontFamily: cssVar(
        '--font-terminal',
        cssVar('--font-mono', 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'),
      ),
      fontSize: 13,
      cursorStyle: 'block',
      cursorBlink: true,
      allowTransparency: true,
      theme: {
        background: '#00000000',
        foreground: cssVar('--color-foreground', '#e6e6e6'),
        cursor: cssVar('--color-foreground', '#e6e6e6'),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void window.electronAPI.openExternal?.(uri);
      }),
    );
    term.open(host);
    try { fit.fit(); } catch { /* host may be detached during fast unmounts */ }

    let disposed = false;
    let ptyHandle: string | null = null;
    const cleanups: (() => void)[] = [];

    const cleanup = (): void => {
      if (disposed) return;
      disposed = true;
      for (const fn of cleanups.splice(0)) {
        // eslint-disable-next-line no-empty -- defensive: one bad teardown must not block the rest.
        try { fn(); } catch {}
      }
      try { term.dispose(); } catch { /* already disposed */ }
    };

    void (async () => {
      let handle: { ptyHandle: string };
      try {
        const customSpawn = spawnRef.current;
        if (customSpawn) {
          handle = await customSpawn({ cols: term.cols, rows: term.rows });
        } else {
          if (!binary) throw new Error('no binary to spawn');
          handle = await api.oneShotTerminalSpawn({
            binary,
            args,
            env,
            cwd,
            cols: term.cols,
            rows: term.rows,
          });
        }
      } catch (err) {
        term.write(`\r\n\x1b[31mFailed to launch ${binary ?? 'process'}: ${(err as Error).message}\x1b[0m\r\n`);
        return;
      }
      if (disposed) {
        await api.oneShotTerminalKill(handle.ptyHandle).catch(() => {});
        return;
      }
      ptyHandle = handle.ptyHandle;

      const unlistenData = window.electronAPI.onEvent(
        `one-shot-terminal-data:${ptyHandle}`,
        (...evtArgs: unknown[]) => {
          const data = evtArgs[0];
          if (typeof data === 'string') term.write(data);
        },
      );
      cleanups.push(unlistenData);

      const unlistenExit = window.electronAPI.onEvent(
        `one-shot-terminal-exit:${ptyHandle}`,
        (...evtArgs: unknown[]) => {
          const info = (evtArgs[0] ?? { exitCode: 0 }) as { exitCode: number; signal?: number };
          onExitRef.current?.(info);
        },
      );
      cleanups.push(unlistenExit);

      const dataDisposable = term.onData((data) => {
        if (!ptyHandle) return;
        api.oneShotTerminalWrite(ptyHandle, data).catch(console.error);
      });
      cleanups.push(() => dataDisposable.dispose());

      const ro = new ResizeObserver(() => {
        try {
          fit.fit();
          if (ptyHandle) {
            api.oneShotTerminalResize(ptyHandle, term.cols, term.rows).catch(console.error);
          }
        } catch {
          /* host detached during teardown; ignore */
        }
      });
      ro.observe(host);
      cleanups.push(() => ro.disconnect());

      cleanups.push(() => {
        const h = ptyHandle;
        if (h) {
          api.oneShotTerminalKill(h).catch(() => { /* main may already be gone */ });
        }
      });
    })();

    if (watchPath) {
      let fired = false;
      let watchTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
        api.fsExists(watchPath).then((res) => {
          if (disposed || fired) return;
          if (res.exists) {
            fired = true;
            try { onWatchFireRef.current?.(watchPath); } catch (err) { console.error(err); }
            if (watchTimer) {
              clearInterval(watchTimer);
              watchTimer = null;
            }
          }
        }).catch(() => { /* main not ready / IPC failure — keep polling */ });
      }, POLL_INTERVAL_MS);
      cleanups.push(() => {
        if (watchTimer) {
          clearInterval(watchTimer);
          watchTimer = null;
        }
      });
    }

    return cleanup;
    // Re-spawns only when the command's identity changes; callbacks are read through refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binary, JSON.stringify(args), cwd, watchPath]);

  return <div ref={hostRef} className={className ?? 'h-full w-full'} />;
}

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { api } from '@/lib/api';

interface OneShotTerminalProps {
  /** Subprocess to spawn (absolute path or PATH-resolvable name). */
  binary: string;
  args: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  /**
   * Optional file path to poll. When it transitions from
   * not-existing → existing, `onWatchFire` fires once with that path.
   * Designed for OAuth-style flows where the CLI writes an auth file on
   * success (`~/.codex/auth.json` etc.).
   */
  watchPath?: string;
  onWatchFire?: (path: string) => void;
  onExit?: (info: { exitCode: number; signal?: number }) => void;
  /** Fired when the consumer closes the modal manually (not used here;
   *  exposed so callers can wire close buttons without a second prop). */
  onCancel?: () => void;
  className?: string;
}

/**
 * Default polling cadence for `watchPath`. 250 ms matches the spec — fast
 * enough that the user perceives the modal closing right after the auth
 * file lands, slow enough that the IPC overhead is negligible.
 */
const POLL_INTERVAL_MS = 250;

/**
 * Shared one-shot pty modal body. Spawns the configured subprocess in a
 * pty via the main-process service, hosts an xterm instance that streams
 * stdout, and pipes user keystrokes back into stdin. Optionally watches a
 * filesystem path and notifies the consumer when it appears.
 *
 * Lifecycle is bound to mount: on unmount the pty is killed and the watch
 * stops. The component itself does not render chrome (header, close
 * button, etc.) — the consumer wraps it in whatever dialog shell they need.
 *
 * The xterm wiring deliberately mirrors `TerminalView` so theme/font/addon
 * behaviour stays consistent across the app.
 */
export function OneShotTerminal({
  binary,
  args,
  env,
  cwd,
  watchPath,
  onWatchFire,
  onExit,
  className,
}: OneShotTerminalProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  // Capture the latest callbacks in refs so the spawn effect (which only
  // runs once per mount) sees fresh closures without re-spawning the pty
  // every time the parent re-renders.
  const onExitRef = useRef(onExit);
  const onWatchFireRef = useRef(onWatchFire);
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

    // Mutable state local to this mount. Used by the async setup chain to
    // bail out if the component unmounts before the spawn IPC resolves.
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
        handle = await api.oneShotTerminalSpawn({
          binary,
          args,
          env,
          cwd,
          cols: term.cols,
          rows: term.rows,
        });
      } catch (err) {
        // Surface the spawn failure inside xterm itself — the modal stays
        // mounted so the user can read it before closing.
        term.write(`\r\n\x1b[31mFailed to launch ${binary}: ${(err as Error).message}\x1b[0m\r\n`);
        return;
      }
      if (disposed) {
        // Unmounted while waiting for spawn — clean up the orphaned pty.
        await api.oneShotTerminalKill(handle.ptyHandle).catch(() => {});
        return;
      }
      ptyHandle = handle.ptyHandle;

      // Inbound: pty stdout → xterm
      const unlistenData = window.electronAPI.onEvent(
        `one-shot-terminal-data:${ptyHandle}`,
        (...evtArgs: unknown[]) => {
          const data = evtArgs[0];
          if (typeof data === 'string') term.write(data);
        },
      );
      cleanups.push(unlistenData);

      // Process exit → notify caller, stop watching, leave xterm visible.
      const unlistenExit = window.electronAPI.onEvent(
        `one-shot-terminal-exit:${ptyHandle}`,
        (...evtArgs: unknown[]) => {
          const info = (evtArgs[0] ?? { exitCode: 0 }) as { exitCode: number; signal?: number };
          onExitRef.current?.(info);
        },
      );
      cleanups.push(unlistenExit);

      // Outbound: xterm keystrokes → pty stdin
      const dataDisposable = term.onData((data) => {
        if (!ptyHandle) return;
        api.oneShotTerminalWrite(ptyHandle, data).catch(console.error);
      });
      cleanups.push(() => dataDisposable.dispose());

      // Resize plumbing — fit on container resize and forward the new dims.
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

      // Kill the subprocess on unmount. Idempotent in the service, so a
      // late kill after the process has already exited is harmless.
      cleanups.push(() => {
        const h = ptyHandle;
        if (h) {
          api.oneShotTerminalKill(h).catch(() => { /* main may already be gone */ });
        }
      });
    })();

    // ── File-existence watcher ──────────────────────────────────────────
    // Polling instead of fs.watch keeps the renderer side of the API
    // tiny (one extra IPC) and works across platforms without races on
    // initial-file-create events. Debounces to a single fire per
    // false → true transition; subsequent polls after the file appears
    // are no-ops until the watcher tears down.
    if (watchPath) {
      let fired = false;
      let watchTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
        api.fsExists(watchPath).then((res) => {
          if (disposed || fired) return;
          if (res.exists) {
            fired = true;
            try { onWatchFireRef.current?.(watchPath); } catch (err) { console.error(err); }
            // No need to keep polling once we've fired.
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
    // The spawn args are captured by closure; this effect intentionally
    // only re-runs when the binary/args/cwd identity changes. Most
    // consumers mount with fixed values, so this is effectively
    // mount/unmount-only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binary, JSON.stringify(args), cwd, watchPath]);

  return <div ref={hostRef} className={className ?? 'h-full w-full'} />;
}

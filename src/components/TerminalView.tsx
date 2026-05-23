import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { api } from '@/lib/api';

interface TerminalViewProps {
  tabId: string;
}

export function TerminalView({ tabId }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    // Read OmniFex theme tokens from CSS custom properties so the terminal
    // tracks the app's theme. Note: this reads at mount only; if the user
    // switches themes without unmounting (e.g. via ThemeContext mid-session),
    // the terminal will keep its initial palette until next remount. Acceptable
    // for Phase 1 — revisit if theme-switching mid-session becomes common.
    const styles = getComputedStyle(document.documentElement);
    const cssVar = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;

    const term = new Terminal({
      fontFamily: cssVar('--font-mono', 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'),
      fontSize: 13,
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
        // WebLinksAddon replaces (not augments) its default open behavior, so
        // we only need to fire openExternal; no preventDefault required.
        void window.electronAPI.openExternal?.(uri);
      }),
    );
    term.open(hostRef.current);
    fit.fit();

    api.tuiResize(tabId, term.cols, term.rows).catch(console.error);

    const dataDisposable = term.onData((data) => {
      api.tuiWrite(tabId, data).catch(console.error);
    });

    const unlistenData = window.electronAPI.onEvent(
      `session-tui-data:${tabId}`,
      (...args: unknown[]) => {
        const data = args[0];
        if (typeof data === 'string') term.write(data);
      },
    );

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        api.tuiResize(tabId, term.cols, term.rows).catch(console.error);
      } catch {
        // ResizeObserver can fire after disposal; ignore.
      }
    });
    ro.observe(hostRef.current);

    return () => {
      ro.disconnect();
      dataDisposable.dispose();
      unlistenData();
      term.dispose();
    };
  }, [tabId]);

  return <div ref={hostRef} className="h-full w-full" />;
}

import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { api } from '@/lib/api';
import { useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';

interface TerminalViewProps {
  tabId: string;
}

/**
 * Imperative handle exposed to the wrapping layout — lets the TUI card's
 * scroll buttons drive xterm's scrollback without reaching into the
 * Terminal instance directly. Kept narrow on purpose; add new methods only
 * when a caller needs them.
 */
export interface TerminalViewHandle {
  scrollToTop: () => void;
  scrollToBottom: () => void;
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView({ tabId }, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const { config } = useMessageRenderingConfig();
    const { fontSize, cursorStyle } = config.terminal;

    useImperativeHandle(ref, () => ({
      scrollToTop: () => { termRef.current?.scrollToTop(); },
      scrollToBottom: () => { termRef.current?.scrollToBottom(); },
    }));

    // Mount: construct the terminal once per tabId. Settings-driven options
    // (font size, cursor style) are read from `config` here for the initial
    // value, then kept in sync by the change effect below without
    // re-mounting xterm — re-mounting would lose scrollback and force a
    // visible flash.
    useEffect(() => {
      if (!hostRef.current) return;

      const styles = getComputedStyle(document.documentElement);
      const cssVar = (name: string, fallback: string): string =>
        styles.getPropertyValue(name).trim() || fallback;

      const term = new Terminal({
        fontFamily: cssVar(
          '--font-terminal',
          cssVar('--font-mono', 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'),
        ),
        fontSize,
        cursorStyle,
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
      termRef.current = term;
      fitRef.current = fit;

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
        termRef.current = null;
        fitRef.current = null;
      };
      // tabId is the only structural dep; fontSize / cursorStyle apply via
      // the second effect so a settings change doesn't re-mount xterm.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabId]);

    // Apply settings-driven option changes in place. xterm supports runtime
    // updates via `term.options.*`; font-size changes require a fit() so the
    // column count stays correct, which means re-publishing the new dims to
    // main so the PTY matches.
    useEffect(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term) return;
      term.options.fontSize = fontSize;
      term.options.cursorStyle = cursorStyle;
      if (fit) {
        try {
          fit.fit();
          api.tuiResize(tabId, term.cols, term.rows).catch(console.error);
        } catch {
          /* fit can throw if the host has been detached; ignore */
        }
      }
    }, [fontSize, cursorStyle, tabId]);

    return <div ref={hostRef} className="h-full w-full" />;
  },
);

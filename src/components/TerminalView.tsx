import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '@/lib/api';

interface TerminalViewProps {
  tabId: string;
}

export function TerminalView({ tabId }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowTransparency: true,
      theme: { background: '#00000000' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

    // Send initial size to the backend so the pty matches what xterm drew.
    api.tuiResize(tabId, term.cols, term.rows).catch(console.error);

    // Keystrokes → backend
    const dataDisposable = term.onData((data) => {
      api.tuiWrite(tabId, data).catch(console.error);
    });

    // Backend data → xterm
    const unlistenData = window.electronAPI.onEvent(
      `session-tui-data:${tabId}`,
      (...args: unknown[]) => {
        const data = args[0];
        if (typeof data === 'string') term.write(data);
      },
    );

    // Resize → backend
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

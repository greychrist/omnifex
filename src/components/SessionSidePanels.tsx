import * as React from 'react';
import { AnimatePresence } from 'framer-motion';
import { ResizableSidePanel } from '@/components/ResizableSidePanel';

export type SessionSidePanelKey = 'inspector' | 'mcp' | 'plugins' | 'permissions' | 'context';

const PANELS: Record<SessionSidePanelKey, { title: string; storageKey: string }> = {
  inspector: { title: 'Session inspector', storageKey: 'omnifex.sessionInspector.panelWidth' },
  mcp: { title: 'MCP Servers', storageKey: 'omnifex.mcp.panelWidth' },
  plugins: { title: 'Plugins', storageKey: 'omnifex.plugins.panelWidth' },
  permissions: { title: 'Permissions', storageKey: 'omnifex.permissions.panelWidth' },
  // The context panel was the first overlay; keep the width users saved.
  context: { title: 'Session context', storageKey: 'omnifex.contextLedger.panelWidth' },
};

export interface SessionSidePanelsProps {
  /** Which panel is open. One at a time: the toolbar buttons toggle, and
   *  opening one closes whichever was showing. */
  open: SessionSidePanelKey | null;
  onClose: () => void;
  content: Record<SessionSidePanelKey, React.ReactNode>;
}

/**
 * The session's side panels, hosted as ONE overlay `ResizableSidePanel`.
 *
 * Mount this inside the messages area. The panel then overlays the transcript
 * and stops where the transcript stops, so the subagent bar and the composer
 * stay visible beneath it — the way the context panel already worked. The
 * MCP, Plugins, Permissions and Inspector panels used to be absolute within
 * the whole chat body AND pushed the transcript and composer left by their
 * width (`sm:mr-96`), which reflowed every message on every open.
 *
 * Only the open panel's body is mounted; the others are plain elements the
 * caller built and nothing renders them.
 */
export function SessionSidePanels({ open, onClose, content }: SessionSidePanelsProps): React.JSX.Element {
  return (
    <AnimatePresence>
      {open && (
        <ResizableSidePanel
          key={open}
          storageKey={PANELS[open].storageKey}
          title={PANELS[open].title}
          onClose={onClose}
        >
          {content[open]}
        </ResizableSidePanel>
      )}
    </AnimatePresence>
  );
}

import * as React from 'react';
import { AnimatePresence } from 'framer-motion';
import { ResizableSidePanel } from '@/components/ResizableSidePanel';

export type SessionSidePanelKey = 'inspector' | 'permissions' | 'context';

const PANELS: Record<SessionSidePanelKey, { title: string; storageKey: string }> = {
  inspector: { title: 'Session inspector', storageKey: 'omnifex.sessionInspector.panelWidth' },
  permissions: { title: 'Permissions', storageKey: 'omnifex.permissions.panelWidth' },
  // Storage key predates the merged panels; kept so saved widths survive.
  context: { title: 'Session context', storageKey: 'omnifex.contextLedger.panelWidth' },
};

export interface SessionSidePanelsProps {
  open: SessionSidePanelKey | null;
  onClose: () => void;
  content: Record<SessionSidePanelKey, React.ReactNode>;
  actions?: Partial<Record<SessionSidePanelKey, React.ReactNode>>;
}

// Mount inside the messages area so it overlays the transcript; pushing content aside (`sm:mr-96`) reflowed every message on open.
export function SessionSidePanels({ open, onClose, content, actions }: SessionSidePanelsProps): React.JSX.Element {
  return (
    <AnimatePresence>
      {open && (
        <ResizableSidePanel
          key={open}
          storageKey={PANELS[open].storageKey}
          title={PANELS[open].title}
          actions={actions?.[open]}
          onClose={onClose}
        >
          {content[open]}
        </ResizableSidePanel>
      )}
    </AnimatePresence>
  );
}

import React from 'react';

interface BrainNoteViewerProps {
  accountId: number | null;
  notePath: string | null;
  onNavigate: (notePath: string) => void;
  onChanged: () => Promise<void> | void;
}

// Filled in by Task 12.
export const BrainNoteViewer: React.FC<BrainNoteViewerProps> = () => null;

export default BrainNoteViewer;

import React from 'react';

interface BrainNoteListProps {
  accountId: number | null;
  notes: string[];
  selected: string | null;
  onSelect: (notePath: string) => void;
}

// Filled in by Task 11.
export const BrainNoteList: React.FC<BrainNoteListProps> = () => null;

export default BrainNoteList;

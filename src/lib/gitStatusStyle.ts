import { FileInput, FileMinus, FilePen, FilePlus, type LucideIcon } from 'lucide-react';
import type { GitChangedFileStatus } from '@/lib/api';

/**
 * One colour per bucket the git watcher counts: tracked files that differ
 * from HEAD are "changed", everything else is "untracked". The branch widget,
 * the tab status popover and the diff viewer's file tree all read from here —
 * the tree once had its own palette with the two colours swapped.
 */
export interface GitStatusStyle {
  Icon: LucideIcon;
  className: string;
}

export const GIT_CHANGED_STYLE: GitStatusStyle = { Icon: FilePen, className: 'text-emerald-400' };
export const GIT_UNTRACKED_STYLE: GitStatusStyle = { Icon: FilePlus, className: 'text-amber-300' };

/**
 * Per-file style for the diff tree. Colour follows the widget's bucket; the
 * icon still tells the four kinds of "changed" apart.
 */
export const GIT_FILE_STATUS_STYLE: Record<GitChangedFileStatus, GitStatusStyle> = {
  modified: GIT_CHANGED_STYLE,
  added: { Icon: FilePlus, className: GIT_CHANGED_STYLE.className },
  deleted: { Icon: FileMinus, className: GIT_CHANGED_STYLE.className },
  renamed: { Icon: FileInput, className: GIT_CHANGED_STYLE.className },
  untracked: GIT_UNTRACKED_STYLE,
};

import { FileInput, FileMinus, FilePen, FilePlus, type LucideIcon } from 'lucide-react';
import type { GitChangedFileStatus } from '@/lib/api';

/**
 * One color per bucket the git watcher counts: tracked files that differ
 * from HEAD are "changed", everything else is "untracked". The branch widget,
 * the tab status popover and the diff viewer's file tree all read from here —
 * the tree once had its own palette with the two colors swapped.
 */
export interface GitStatusStyle {
  Icon: LucideIcon;
  className: string;
}

// Theme tokens (styles.css), darker under .theme-light: the counts sit on
// tinted branch chips, where the dark themes' bright shades wash out.
export const GIT_CHANGED_STYLE: GitStatusStyle = { Icon: FilePen, className: 'text-git-changed' };
export const GIT_UNTRACKED_STYLE: GitStatusStyle = { Icon: FilePlus, className: 'text-git-untracked' };

/**
 * Per-file style for the diff tree. Color follows the widget's bucket; the
 * icon still tells the four kinds of "changed" apart.
 */
export const GIT_FILE_STATUS_STYLE: Record<GitChangedFileStatus, GitStatusStyle> = {
  modified: GIT_CHANGED_STYLE,
  added: { Icon: FilePlus, className: GIT_CHANGED_STYLE.className },
  deleted: { Icon: FileMinus, className: GIT_CHANGED_STYLE.className },
  renamed: { Icon: FileInput, className: GIT_CHANGED_STYLE.className },
  untracked: GIT_UNTRACKED_STYLE,
};

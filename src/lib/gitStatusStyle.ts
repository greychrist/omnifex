import { FileInput, FileMinus, FilePen, FilePlus, type LucideIcon } from 'lucide-react';
import type { GitChangedFileStatus } from '@/lib/api';

export interface GitStatusStyle {
  Icon: LucideIcon;
  className: string;
}

export const GIT_CHANGED_STYLE: GitStatusStyle = { Icon: FilePen, className: 'text-git-changed' };
export const GIT_UNTRACKED_STYLE: GitStatusStyle = { Icon: FilePlus, className: 'text-git-untracked' };

export const GIT_FILE_STATUS_STYLE: Record<GitChangedFileStatus, GitStatusStyle> = {
  modified: GIT_CHANGED_STYLE,
  added: { Icon: FilePlus, className: GIT_CHANGED_STYLE.className },
  deleted: { Icon: FileMinus, className: GIT_CHANGED_STYLE.className },
  renamed: { Icon: FileInput, className: GIT_CHANGED_STYLE.className },
  untracked: GIT_UNTRACKED_STYLE,
};

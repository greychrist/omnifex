import type { ResolvePair } from '@/lib/api';
import type { Tab } from '@/contexts/TabContext';
import { slotToResolution } from '@/lib/accountResolution';
import { renderCliReviewPrompt } from '@/lib/cliReviewPrompt';

export interface CliReviewLaunchArgs {
  repoDir: string;
  reviewedVersion: string;
  installedVersion: string;
  pair: ResolvePair;
}

export interface CliReviewLaunch {
  tab: Omit<Tab, 'id' | 'order' | 'createdAt' | 'updatedAt'>;
  hasAccount: boolean;
}

/** Claude-only: the changelog under review is Claude Code's, so a Codex slot is never a target. */
export function buildCliReviewLaunch({
  repoDir,
  reviewedVersion,
  installedVersion,
  pair,
}: CliReviewLaunchArgs): CliReviewLaunch {
  const resolution = slotToResolution(pair.claude);
  const title = `CLI ${installedVersion} review`;
  const common = {
    type: 'chat' as const,
    title,
    agent: 'claude' as const,
    initialProjectPath: repoDir,
    status: 'idle' as const,
    hasUnsavedChanges: false,
  };

  if (!resolution) {
    return { hasAccount: false, tab: common };
  }

  const d = resolution.account.session_defaults;
  return {
    hasAccount: true,
    tab: {
      ...common,
      accountName: resolution.account.name,
      accountColor: pair.claude?.account.color,
      accountIcon: pair.claude?.account.icon,
      initialPrompt: renderCliReviewPrompt(reviewedVersion, installedVersion),
      initialSessionConfig: {
        model: d?.model ?? 'opus',
        effort: d?.effort ?? 'high',
        permissionMode: d?.permissionMode ?? 'acceptEdits',
        accountResolution: resolution,
      },
    },
  };
}

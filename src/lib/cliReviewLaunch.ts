import type { ResolvePair } from '@/lib/api';
import type { Tab } from '@/contexts/TabContext';
import { slotToResolution } from '@/lib/accountResolution';
import { renderCliReviewPrompt } from '@/lib/cliReviewPrompt';

export interface CliReviewLaunchArgs {
  /** OmniFex source checkout to run the review in (`CliReviewStatus.repo_dir`). */
  repoDir: string;
  reviewedVersion: string;
  installedVersion: string;
  /** Account routing for `repoDir`, as returned by `resolveAccountForProject`. */
  pair: ResolvePair;
}

export interface CliReviewLaunch {
  /** Chat-tab fields, ready for `addTab`. */
  tab: Omit<Tab, 'id' | 'order' | 'createdAt' | 'updatedAt'>;
  /** False when no Claude account routes `repoDir` — the tab opens without
   *  auto-start so the normal routing guidance is what the user sees. */
  hasAccount: boolean;
}

/**
 * Build the chat tab the Updates popover's drift warning launches.
 *
 * The prompt is the whole procedure (`cliReviewPrompt.ts`), not a slash-command
 * invocation: the old command file lived under a gitignored `.claude/`, so it
 * only ever existed on the author's machine.
 *
 * Claude-only by construction: the changelog under review is Claude Code's, so
 * a Codex slot is never a valid target even when it's the only one that routes
 * the folder.
 */
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

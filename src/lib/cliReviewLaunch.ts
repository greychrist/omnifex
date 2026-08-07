import type { ResolvePair } from '@/lib/api';
import type { Tab } from '@/contexts/TabContext';
import { normalizeThinkingConfig } from '@/lib/thinkingConfig';
import { slotToResolution } from '@/lib/accountResolution';

/**
 * The prompt the drift warning launches.
 *
 * The review procedure itself lives in
 * `.claude/commands/cli-changelog-review.md` — editable without rebuilding the
 * app. All the app contributes is the version range that actually drifted.
 */
export function buildCliReviewPrompt(reviewedVersion: string, installedVersion: string): string {
  return `/cli-changelog-review ${reviewedVersion} ${installedVersion}`;
}

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
      initialPrompt: buildCliReviewPrompt(reviewedVersion, installedVersion),
      initialSessionConfig: {
        model: d?.model ?? 'opus',
        effort: d?.effort ?? 'high',
        thinkingConfig: d?.thinkingConfig ? normalizeThinkingConfig(d.thinkingConfig) : undefined,
        permissionMode: d?.permissionMode ?? 'acceptEdits',
        sessionStartMode: 'rich',
        accountResolution: resolution,
      },
    },
  };
}

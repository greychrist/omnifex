import { compareCliVersions, parseCliVersion } from './claude-cli-review';

/** Last Claude Code release the user was notified about. */
export const CLI_NOTIFIED_VERSION_SETTING_KEY = 'claude_cli_notified_version';

export interface NoticeStore {
  getSetting(key: string): string | null;
  saveSetting(key: string, value: string): void;
}

/**
 * True exactly once per Claude Code release: the caller that wins raises the
 * "new version" notification, every other window, client and relaunch loses.
 *
 * Synchronous read-compare-write, so within one daemon it is atomic — the
 * renderer's windows all funnel through it. Older-than-notified never claims,
 * so a registry briefly serving a stale `latest` cannot re-announce one.
 */
export function claimCliUpdateNotice(store: NoticeStore, version: string): boolean {
  const next = parseCliVersion(version);
  if (!next) return false;
  const last = parseCliVersion(store.getSetting(CLI_NOTIFIED_VERSION_SETTING_KEY));
  if (last && compareCliVersions(next, last) <= 0) return false;
  store.saveSetting(CLI_NOTIFIED_VERSION_SETTING_KEY, next);
  return true;
}

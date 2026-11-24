import { compareCliVersions, parseCliVersion } from './claude-cli-review';

export const CLI_NOTIFIED_VERSION_SETTING_KEY = 'claude_cli_notified_version';

export interface NoticeStore {
  getSetting(key: string): string | null;
  saveSetting(key: string, value: string): void;
}

/** True once per release: synchronous read-compare-write, atomic within one daemon. Older-than-notified never claims. */
export function claimCliUpdateNotice(store: NoticeStore, version: string): boolean {
  const next = parseCliVersion(version);
  if (!next) return false;
  const last = parseCliVersion(store.getSetting(CLI_NOTIFIED_VERSION_SETTING_KEY));
  if (last && compareCliVersions(next, last) <= 0) return false;
  store.saveSetting(CLI_NOTIFIED_VERSION_SETTING_KEY, next);
  return true;
}

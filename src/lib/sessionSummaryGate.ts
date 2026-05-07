import {
  api,
  ENABLED_SETTING_KEY,
  AUTO_ON_CLOSE_SETTING_KEY,
} from '@/lib/api';

/**
 * Renderer-side mirror of the auto-on-close gate in `electron/main.ts`.
 *
 * The lifecycle close hook in main only fires `summaryGenerate` when both
 *   - sessionsSummary.enabled (master switch), AND
 *   - sessionsSummary.autoOnClose ("Generate summaries automatically when
 *     leaving a session")
 * are stored as the literal string `'true'`. This helper applies the same
 * gate to other "user is leaving the session" entry points the renderer
 * fires before the SDK session is actually torn down — currently the
 * back-button in `ClaudeCodeSession`, which keeps the SDK session alive
 * but should still be considered "leaving" from the user's perspective.
 *
 * The manual refresh button in `SessionList` deliberately bypasses this
 * gate: that path is an explicit user action, not an auto-trigger, and
 * should work even when both global toggles are off.
 *
 * Fire-and-forget: rejections from `api.summaryGenerate` are swallowed so
 * callers don't have to wrap every call site in `.catch(...)`. The IPC
 * layer logs failures separately.
 */
export async function maybeAutoGenerateSummaryOnLeave(
  sessionUuid: string,
  projectPath: string,
  configDir: string | null,
): Promise<void> {
  let enabled: string | null;
  let autoOnClose: string | null;
  try {
    [enabled, autoOnClose] = await Promise.all([
      api.getSetting(ENABLED_SETTING_KEY),
      api.getSetting(AUTO_ON_CLOSE_SETTING_KEY),
    ]);
  } catch (err) {
    console.warn('[sessionSummaryGate] settings read failed:', err);
    return;
  }
  if (enabled !== 'true' || autoOnClose !== 'true') return;
  try {
    await api.summaryGenerate(sessionUuid, projectPath, configDir);
  } catch (err) {
    console.warn('[sessionSummaryGate] summaryGenerate failed:', err);
  }
}

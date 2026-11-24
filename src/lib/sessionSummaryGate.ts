import {
  api,
  ENABLED_SETTING_KEY,
  AUTO_ON_CLOSE_SETTING_KEY,
} from '@/lib/api';

/** Mirrors daemon/session-close-work.ts's gate: both settings must be the literal string 'true'. */
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

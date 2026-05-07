// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the api surface up-front so the helper picks up our stubs at import time.
vi.mock('@/lib/api', () => ({
  api: {
    getSetting: vi.fn(),
    summaryGenerate: vi.fn(),
  },
  ENABLED_SETTING_KEY: 'sessionsSummary.enabled',
  AUTO_ON_CLOSE_SETTING_KEY: 'sessionsSummary.autoOnClose',
}));

import { api } from '@/lib/api';
import { maybeAutoGenerateSummaryOnLeave } from '../sessionSummaryGate';

const SESSION = 'sess-uuid-1';
const PROJECT = '/Users/x/proj';
const CONFIG_DIR = '/Users/x/.claude';

function stubSettings(enabled: string | null, autoOnClose: string | null) {
  vi.mocked(api.getSetting).mockImplementation(async (key: string) => {
    if (key === 'sessionsSummary.enabled') return enabled;
    if (key === 'sessionsSummary.autoOnClose') return autoOnClose;
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.summaryGenerate).mockResolvedValue({ status: 'unchanged' } as any);
});

describe('maybeAutoGenerateSummaryOnLeave', () => {
  // The auto-on-leave gate must mirror the lifecycle hook in
  // electron/main.ts so the back-button path doesn't bypass the user's
  // "Generate summaries automatically when leaving a session" toggle.
  //
  // Both flags must be 'true' for generation to fire. Anything else
  // (including missing settings) skips. Manual refresh button stays
  // ungated by going through api.summaryGenerate directly.
  it('calls summaryGenerate when both flags are "true"', async () => {
    stubSettings('true', 'true');
    await maybeAutoGenerateSummaryOnLeave(SESSION, PROJECT, CONFIG_DIR);
    expect(api.summaryGenerate).toHaveBeenCalledTimes(1);
    expect(api.summaryGenerate).toHaveBeenCalledWith(SESSION, PROJECT, CONFIG_DIR);
  });

  it('skips when autoOnClose is "false" even if enabled is "true"', async () => {
    stubSettings('true', 'false');
    await maybeAutoGenerateSummaryOnLeave(SESSION, PROJECT, CONFIG_DIR);
    expect(api.summaryGenerate).not.toHaveBeenCalled();
  });

  it('skips when enabled is "false" even if autoOnClose is "true"', async () => {
    stubSettings('false', 'true');
    await maybeAutoGenerateSummaryOnLeave(SESSION, PROJECT, CONFIG_DIR);
    expect(api.summaryGenerate).not.toHaveBeenCalled();
  });

  it('skips when both flags are "false"', async () => {
    stubSettings('false', 'false');
    await maybeAutoGenerateSummaryOnLeave(SESSION, PROJECT, CONFIG_DIR);
    expect(api.summaryGenerate).not.toHaveBeenCalled();
  });

  it('skips when settings are unset (null)', async () => {
    // Mirrors `db.getSetting(...) === 'true'` semantics in the lifecycle
    // hook: anything that isn't the literal string 'true' is treated as
    // off. Defaults are seeded to 'true' by ensureDefaultSettings on
    // first launch, but a missing row should not silently turn the
    // auto-trigger on.
    stubSettings(null, null);
    await maybeAutoGenerateSummaryOnLeave(SESSION, PROJECT, CONFIG_DIR);
    expect(api.summaryGenerate).not.toHaveBeenCalled();
  });

  it('passes the configDir through (including null) to summaryGenerate', async () => {
    stubSettings('true', 'true');
    await maybeAutoGenerateSummaryOnLeave(SESSION, PROJECT, null);
    expect(api.summaryGenerate).toHaveBeenCalledWith(SESSION, PROJECT, null);
  });

  it('swallows summaryGenerate rejections so callers can fire-and-forget', async () => {
    stubSettings('true', 'true');
    vi.mocked(api.summaryGenerate).mockRejectedValueOnce(new Error('boom'));
    // Must not throw.
    await expect(
      maybeAutoGenerateSummaryOnLeave(SESSION, PROJECT, CONFIG_DIR),
    ).resolves.toBeUndefined();
  });

  it('swallows getSetting rejections and skips generation', async () => {
    // If the IPC layer can't even read the toggles, treat it as
    // gated-off and skip — never auto-generate on a failed read.
    vi.mocked(api.getSetting).mockRejectedValue(new Error('ipc dead'));
    await expect(
      maybeAutoGenerateSummaryOnLeave(SESSION, PROJECT, CONFIG_DIR),
    ).resolves.toBeUndefined();
    expect(api.summaryGenerate).not.toHaveBeenCalled();
  });
});

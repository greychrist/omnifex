// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    await expect(
      maybeAutoGenerateSummaryOnLeave(SESSION, PROJECT, CONFIG_DIR),
    ).resolves.toBeUndefined();
  });

  it('swallows getSetting rejections and skips generation', async () => {
    vi.mocked(api.getSetting).mockRejectedValue(new Error('ipc dead'));
    await expect(
      maybeAutoGenerateSummaryOnLeave(SESSION, PROJECT, CONFIG_DIR),
    ).resolves.toBeUndefined();
    expect(api.summaryGenerate).not.toHaveBeenCalled();
  });
});

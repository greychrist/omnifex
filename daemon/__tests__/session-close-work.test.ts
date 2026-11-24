import { describe, it, expect, vi } from 'vitest';
import { createSessionCloseWork } from '../session-close-work';
import {
  BRAIN_AUTO_INDEX_SETTING_KEY,
  BRAIN_CURATE_SETTING_KEY,
} from '../services/brain/queue';
import { AUTO_ON_CLOSE_SETTING_KEY, ENABLED_SETTING_KEY } from '../services/sessions-summary';

describe('session close work', () => {
  function harness(settings: Record<string, string>, opts: { drainEnabled?: () => boolean } = {}) {
    const calls: string[] = [];
    const brain = {
      enqueueSource: vi.fn(() => { calls.push('enqueueSource'); return 1; }),
      enqueueProjectSources: vi.fn(() => { calls.push('enqueueProjectSources'); return 1; }),
      enqueueCuration: vi.fn(() => { calls.push('enqueueCuration'); return 1; }),
      drainQueue: vi.fn(() => { calls.push('drainQueue'); return Promise.resolve(); }),
    };
    const summary = { generateSummary: vi.fn(() => { calls.push('generateSummary'); return Promise.resolve(); }) };
    const warn = vi.fn();
    const onClose = createSessionCloseWork({
      db: { getSetting: (k: string) => settings[k] ?? null },
      accounts: {
        getAccountByConfigDir: (dir: string) => (dir === '/cfg/personal' ? { id: 7 } : null),
      },
      brain: () => brain,
      summary: () => summary,
      warn,
      ...opts,
    });
    return { onClose, brain, summary, warn, calls };
  }

  const ALL_ON = {
    [ENABLED_SETTING_KEY]: 'true',
    [AUTO_ON_CLOSE_SETTING_KEY]: 'true',
    [BRAIN_AUTO_INDEX_SETTING_KEY]: 'true',
    [BRAIN_CURATE_SETTING_KEY]: 'true',
  };

  /** Fire-and-forget by design, so the assertions need the microtasks drained. */
  const settled = () => new Promise((r) => setTimeout(r, 0));

  it('does not start a summary on shutdown, but still does the Brain work', async () => {
    // process.exit follows within milliseconds and would kill the summary's CLI call.
    const h = harness(ALL_ON);
    h.onClose('s1', '/repo', '/cfg/personal', 'shutdown');
    await settled();
    expect(h.summary.generateSummary).not.toHaveBeenCalled();
    expect(h.brain.enqueueSource).toHaveBeenCalledWith(7, 's1');
  });

  it('summarizes, indexes, curates and drains when every switch is on', async () => {
    const h = harness(ALL_ON);
    h.onClose('s1', '/repo', '/cfg/personal');
    await settled();

    expect(h.summary.generateSummary).toHaveBeenCalledWith('s1', '/repo', '/cfg/personal');
    expect(h.brain.enqueueSource).toHaveBeenCalledWith(7, 's1');
    expect(h.brain.enqueueProjectSources).toHaveBeenCalledWith(7, '/repo');
    expect(h.brain.enqueueCuration).toHaveBeenCalledWith(7);
    // Curation is selected from the vault as it stands BEFORE the drain, so a
    // note pushed over the threshold by this close is picked up on the next one.
    expect(h.calls).toEqual([
      'generateSummary', 'enqueueSource', 'enqueueProjectSources', 'enqueueCuration', 'drainQueue',
    ]);
  });

  it('still does Brain work when summaries are off', async () => {
    const h = harness({ ...ALL_ON, [ENABLED_SETTING_KEY]: 'false' });
    h.onClose('s1', '/repo', '/cfg/personal');
    await settled();

    expect(h.summary.generateSummary).not.toHaveBeenCalled();
    expect(h.brain.enqueueSource).toHaveBeenCalled();
    expect(h.brain.drainQueue).toHaveBeenCalled();
  });

  it('skips the summary when auto-on-close alone is off', async () => {
    const h = harness({ ...ALL_ON, [AUTO_ON_CLOSE_SETTING_KEY]: 'false' });
    h.onClose('s1', '/repo', '/cfg/personal');
    await settled();
    expect(h.summary.generateSummary).not.toHaveBeenCalled();
  });

  it('arms the drain from either Brain switch', async () => {
    const h = harness({ ...ALL_ON, [BRAIN_AUTO_INDEX_SETTING_KEY]: 'false' });
    h.onClose('s1', '/repo', '/cfg/personal');
    await settled();

    expect(h.brain.enqueueSource).not.toHaveBeenCalled();
    expect(h.brain.enqueueProjectSources).not.toHaveBeenCalled();
    expect(h.brain.enqueueCuration).toHaveBeenCalledWith(7);
    expect(h.brain.drainQueue).toHaveBeenCalled();
  });

  it('does nothing Brain-side when both Brain switches are off', async () => {
    const h = harness({ [ENABLED_SETTING_KEY]: 'true', [AUTO_ON_CLOSE_SETTING_KEY]: 'true' });
    h.onClose('s1', '/repo', '/cfg/personal');
    await settled();

    expect(h.calls).toEqual(['generateSummary']);
  });

  it('does no Brain work for a config dir no account owns', async () => {
    const h = harness(ALL_ON);
    h.onClose('s1', '/repo', '/cfg/nobody');
    await settled();

    expect(h.brain.enqueueSource).not.toHaveBeenCalled();
    expect(h.brain.drainQueue).not.toHaveBeenCalled();
  });

  it('enqueues but does not drain when this process does not own the drain', async () => {
    const h = harness(ALL_ON, { drainEnabled: () => false });
    h.onClose('s1', '/repo', '/cfg/personal');
    await settled();

    expect(h.brain.enqueueSource).toHaveBeenCalled();
    expect(h.brain.enqueueCuration).toHaveBeenCalled();
    expect(h.brain.drainQueue).not.toHaveBeenCalled();
  });

  it('re-reads the switches on every close', async () => {
    const settings: Record<string, string> = { ...ALL_ON };
    const h = harness(settings);

    h.onClose('s1', '/repo', '/cfg/personal');
    await settled();
    expect(h.brain.enqueueSource).toHaveBeenCalledTimes(1);

    settings[BRAIN_AUTO_INDEX_SETTING_KEY] = 'false';
    settings[BRAIN_CURATE_SETTING_KEY] = 'false';
    h.onClose('s2', '/repo', '/cfg/personal');
    await settled();
    expect(h.brain.enqueueSource).toHaveBeenCalledTimes(1);
  });

  it('reports a failing summary without touching Brain work', async () => {
    const h = harness(ALL_ON);
    h.summary.generateSummary.mockReturnValueOnce(Promise.reject(new Error('boom')));
    h.onClose('s1', '/repo', '/cfg/personal');
    await settled();

    expect(h.warn).toHaveBeenCalledWith('auto-summarize on close failed', expect.anything());
    expect(h.brain.drainQueue).toHaveBeenCalled();
  });

  it('reports a failing drain rather than throwing', async () => {
    const h = harness(ALL_ON);
    h.brain.drainQueue.mockReturnValueOnce(Promise.reject(new Error('db locked')));
    expect(() => { h.onClose('s1', '/repo', '/cfg/personal'); }).not.toThrow();
    await settled();

    expect(h.warn).toHaveBeenCalledWith('brain work on close failed', expect.anything());
  });

  it('survives a composition root with no Brain and no summary service', async () => {
    const onClose = createSessionCloseWork({
      db: { getSetting: (k: string) => (ALL_ON as Record<string, string>)[k] ?? null },
      accounts: { getAccountByConfigDir: () => ({ id: 7 }) },
      brain: () => undefined,
      summary: () => undefined,
      warn: () => {},
    });
    expect(() => { onClose('s1', '/repo', '/cfg/personal'); }).not.toThrow();
    await settled();
  });
});

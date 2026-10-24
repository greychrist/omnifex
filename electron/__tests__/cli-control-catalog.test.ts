import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { CLI_CONTROL_REQUESTS } from '../services/sessions/cli-control-catalog';
import { loadInventory } from '../../scripts/cli-review-diff';

const REPO = path.resolve(__dirname, '../..');

describe('CLI_CONTROL_REQUESTS', () => {
  // The catalog is only worth keeping if "wired" means wired. Both directions
  // are read from the daemon's sources, so a request that is added or removed
  // without updating the catalog fails here.
  it('marks as wired exactly the requests the daemon sends', async () => {
    const sent = (await loadInventory(REPO)).controlSubtypesSent;
    const wired = Object.entries(CLI_CONTROL_REQUESTS)
      .filter(([, e]) => e.status === 'wired')
      .map(([s]) => s)
      .sort();
    expect(wired).toEqual([...sent].sort());
  });

  it('gives every planned or declined request a reason', () => {
    for (const [subtype, e] of Object.entries(CLI_CONTROL_REQUESTS)) {
      if (e.status === 'wired') continue;
      expect(e.note.length, subtype).toBeGreaterThan(10);
    }
  });

  it('records the request parameters for everything not yet wired', () => {
    for (const [subtype, e] of Object.entries(CLI_CONTROL_REQUESTS)) {
      if (e.status !== 'planned') continue;
      expect(e.params, subtype).toBeDefined();
    }
  });
});

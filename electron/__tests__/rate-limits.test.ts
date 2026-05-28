import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createRateLimitsService, type RateLimitsService, type RateLimitInfo } from '../services/rate-limits';
import type { AccountsService, Account } from '../services/accounts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 1,
    name: 'Personal',
    config_dir: '/Users/test/.claude',
    engine: 'claude',
    subscription_label: 'max',
    has_cost: true,
    color: null,
    icon: null,
    cli_path: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeAccountsService(accounts: Account[]): AccountsService {
  return {
    listAccounts: () => accounts,
    createAccount: () => accounts[0],
    updateAccount: () => {},
        updateSummarySettings: () => {},
    deleteAccount: () => {},
    listPathRules: () => [],
    addPathRule: () => ({ id: 1, account_id: 1, account_name: 'Personal', account_engine: 'claude', path_prefix: '/', priority: 0 }),
    removePathRule: () => {},
    resolve: () => ({ claude: null, codex: null }),
    setProjectOverride: () => {},
    listProjectOverrides: () => [],
    explainResolution: () => null,
    discoverAccounts: async () => [],
    scanForNewAccounts: async () => [],
  };
}

function fiveHourEvent(opts: Partial<RateLimitInfo>): RateLimitInfo {
  return {
    status: 'allowed',
    rateLimitType: 'five_hour',
    utilization: 50,
    resetsAt: 1_700_000_000,
    ...opts,
  };
}

interface FiredNotification {
  title: string;
  body: string;
  isError: boolean;
}

interface EmittedEvent {
  channel: string;
  payload: unknown;
}

interface Harness {
  db: Database;
  service: RateLimitsService;
  notifications: FiredNotification[];
  emitted: EmittedEvent[];
  now: () => number;
  setNow: (ms: number) => void;
}

function makeHarness(opts: { accounts?: Account[]; nowMs?: number } = {}): Harness {
  const db = createDatabase(':memory:');
  const accounts = opts.accounts ?? [makeAccount()];
  const accountsService = makeAccountsService(accounts);

  const notifications: FiredNotification[] = [];
  const emitted: EmittedEvent[] = [];
  let now = opts.nowMs ?? 1_700_000_000_000;

  const service = createRateLimitsService({
    db,
    accounts: accountsService,
    notifications: {
      show: (title, body, isError) => {
        notifications.push({ title, body, isError });
      },
    },
    sendToRenderer: (channel, payload) => {
      emitted.push({ channel, payload });
    },
    now: () => now,
  });

  return {
    db,
    service,
    notifications,
    emitted,
    now: () => now,
    setNow: (ms: number) => {
      now = ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rate-limits service', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.db.close();
  });

  describe('recordUtilization', () => {
    it('preserves SDK-derived status on existing snapshot', () => {
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({
        status: 'rejected',
        utilization: 100,
        resetsAt: 1_700_000_000,
      }));
      h.service.recordUtilization('/Users/test/.claude', 'five_hour', 60, 9999);
      const snap = h.service.getSnapshotsByAccount('Personal').find((s) => s.rate_limit_type === 'five_hour')!;
      expect(snap.utilization).toBe(60);
      expect(snap.resets_at).toBe(9999);
      expect(snap.status).toBe('rejected');
    });

    it('creates new snapshot with status=allowed when none exists', () => {
      h.service.recordUtilization('/Users/test/.claude', 'seven_day_sonnet', 6, 5555);
      const snap = h.service.getSnapshotsByAccount('Personal').find((s) => s.rate_limit_type === 'seven_day_sonnet')!;
      expect(snap.utilization).toBe(6);
      expect(snap.resets_at).toBe(5555);
      expect(snap.status).toBe('allowed');
    });

    it('ignores unknown configDir', () => {
      h.service.recordUtilization('/no/such/dir', 'five_hour', 50, null);
      expect(h.service.getSnapshots()).toHaveLength(0);
    });

    it('preserves prior resets_at when called with null', () => {
      // First write seeds a good reset time; a follow-up call with null
      // (e.g. parser failed to extract the resets line) must NOT clobber the
      // good value with null.
      h.service.recordUtilization('/Users/test/.claude', 'five_hour', 30, 1_700_000_000);
      h.service.recordUtilization('/Users/test/.claude', 'five_hour', 35, null);
      const snap = h.service.getSnapshotsByAccount('Personal').find((s) => s.rate_limit_type === 'five_hour')!;
      expect(snap.utilization).toBe(35);
      expect(snap.resets_at).toBe(1_700_000_000);
    });

    it('emits rate-limits:updated with the merged snapshot so renderer pills refresh', () => {
      h.service.recordUtilization('/Users/test/.claude', 'seven_day', 42, 1_700_001_234);
      const evt = h.emitted.find((e) => e.channel === 'rate-limits:updated');
      expect(evt).toBeDefined();
      const payload = evt!.payload as {
        account_name: string;
        snapshot: { rate_limit_type: string; utilization: number; resets_at: number; observed_at: number };
      };
      expect(payload.account_name).toBe('Personal');
      expect(payload.snapshot.rate_limit_type).toBe('seven_day');
      expect(payload.snapshot.utilization).toBe(42);
      expect(payload.snapshot.resets_at).toBe(1_700_001_234);
      expect(payload.snapshot.observed_at).toBe(h.now());
    });
  });

  describe('recordEvent — snapshot persistence', () => {
    it('records a snapshot resolved by configDir', () => {
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 30 }));

      const snaps = h.service.getSnapshots();
      expect(snaps).toHaveLength(1);
      expect(snaps[0]).toMatchObject({
        account_name: 'Personal',
        rate_limit_type: 'five_hour',
        utilization: 30,
        status: 'allowed',
        resets_at: 1_700_000_000,
      });
    });

    it('upserts on second event for same (account, rate_limit_type)', () => {
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 30 }));
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 55 }));

      const snaps = h.service.getSnapshots();
      expect(snaps).toHaveLength(1);
      expect(snaps[0].utilization).toBe(55);
    });

    it('keeps separate rows for five_hour and seven_day on same account', () => {
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 30 }));
      h.service.recordEvent('/Users/test/.claude', {
        status: 'allowed',
        rateLimitType: 'seven_day',
        utilization: 12,
        resetsAt: 1_700_500_000,
      });

      const snaps = h.service.getSnapshots();
      expect(snaps).toHaveLength(2);
      const types = snaps.map((s) => s.rate_limit_type).sort();
      expect(types).toEqual(['five_hour', 'seven_day']);
    });

    it('preserves prior utilization when a follow-up event omits it', () => {
      // First event lands with a real percentage
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 42 }));
      expect(h.service.getSnapshots()[0].utilization).toBe(42);

      // Second event arrives with the same window but no utilization (the
      // SDK does this — emits status pings without re-stating the percent).
      // The widget should keep showing 42, not flip to null.
      h.service.recordEvent('/Users/test/.claude', {
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: 1_700_000_000,
      });
      expect(h.service.getSnapshots()[0].utilization).toBe(42);
    });

    it('preserves prior resets_at when a follow-up event omits it', () => {
      h.service.recordEvent(
        '/Users/test/.claude',
        fiveHourEvent({ utilization: 50, resetsAt: 1_700_000_000 }),
      );
      h.service.recordEvent('/Users/test/.claude', {
        status: 'allowed',
        rateLimitType: 'five_hour',
      });
      expect(h.service.getSnapshots()[0].resets_at).toBe(1_700_000_000);
    });

    it('persists across service instances (same db)', () => {
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 42 }));

      const second = createRateLimitsService({
        db: h.db,
        accounts: makeAccountsService([makeAccount()]),
        notifications: { show: () => {} },
        sendToRenderer: () => {},
        now: () => h.now(),
      });

      const snaps = second.getSnapshots();
      expect(snaps).toHaveLength(1);
      expect(snaps[0].utilization).toBe(42);
    });

    it('skips events for unknown configDir without throwing', () => {
      expect(() =>
        h.service.recordEvent('/some/unknown/dir', fiveHourEvent({ utilization: 50 })),
      ).not.toThrow();
      expect(h.service.getSnapshots()).toHaveLength(0);
    });

    it('emits rate-limits:updated to renderer on each event', () => {
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 30 }));
      expect(h.emitted).toHaveLength(1);
      expect(h.emitted[0].channel).toBe('rate-limits:updated');
    });
  });

  describe('threshold detection — percent crossings', () => {
    it('fires 75% notification once when crossing upward', () => {
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 76 }));
      expect(h.notifications).toHaveLength(1);
      expect(h.notifications[0].body).toMatch(/75%/);
    });

    it('does not re-fire 75% on subsequent events in same window', () => {
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 76 }));
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 80 }));
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 88 }));

      const pct75Fires = h.notifications.filter((n) => n.body.includes('75%'));
      expect(pct75Fires).toHaveLength(1);
    });

    it('fires 90% after 75% in the same window', () => {
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 76 }));
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 91 }));

      expect(h.notifications).toHaveLength(2);
      expect(h.notifications[1].body).toMatch(/90%/);
    });

    it('jumps directly to 90% if first observation is already past it', () => {
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 95 }));
      const bodies = h.notifications.map((n) => n.body);
      expect(bodies.some((b) => b.includes('75%'))).toBe(true);
      expect(bodies.some((b) => b.includes('90%'))).toBe(true);
    });

    it('re-arms thresholds when window rolls over (new resetsAt)', () => {
      h.service.recordEvent(
        '/Users/test/.claude',
        fiveHourEvent({ utilization: 80, resetsAt: 1_700_000_000 }),
      );
      h.service.recordEvent(
        '/Users/test/.claude',
        fiveHourEvent({ utilization: 80, resetsAt: 1_700_018_000 }),
      );

      const pct75Fires = h.notifications.filter((n) => n.body.includes('75%'));
      expect(pct75Fires).toHaveLength(2);
    });

    it('does not fire percent thresholds when utilization is undefined', () => {
      h.service.recordEvent('/Users/test/.claude', {
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: 1_700_000_000,
      });
      const pctFires = h.notifications.filter((n) => /\d+%/.test(n.body));
      expect(pctFires).toHaveLength(0);
    });
  });

  describe('threshold detection — SDK status signals', () => {
    it("fires once on status 'allowed_warning'", () => {
      h.service.recordEvent(
        '/Users/test/.claude',
        fiveHourEvent({ status: 'allowed_warning', utilization: 50 }),
      );
      h.service.recordEvent(
        '/Users/test/.claude',
        fiveHourEvent({ status: 'allowed_warning', utilization: 55 }),
      );

      const warnings = h.notifications.filter((n) => /approaching/i.test(n.body));
      expect(warnings).toHaveLength(1);
    });

    it("fires distinct copy on status 'rejected'", () => {
      h.service.recordEvent(
        '/Users/test/.claude',
        fiveHourEvent({ status: 'rejected', utilization: 100 }),
      );

      const rejection = h.notifications.find((n) => /limit hit/i.test(n.body));
      expect(rejection).toBeDefined();
      expect(rejection!.isError).toBe(true);
    });
  });

  describe('settings', () => {
    it('returns defaults when no settings stored', () => {
      const s = h.service.getSettings();
      expect(s).toMatchObject({
        notifications_enabled: true,
        five_hour_thresholds_pct: [75, 90],
        seven_day_notifications_enabled: false,
        seven_day_thresholds_pct: [75, 90],
      });
    });

    it('persists updates and merges with existing values', () => {
      h.service.updateSettings({ five_hour_thresholds_pct: [50, 75, 90] });
      const s = h.service.getSettings();
      expect(s.five_hour_thresholds_pct).toEqual([50, 75, 90]);
      // unchanged keys should keep defaults
      expect(s.notifications_enabled).toBe(true);
    });

    it('respects notifications_enabled=false (suppresses all)', () => {
      h.service.updateSettings({ notifications_enabled: false });
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 95 }));
      h.service.recordEvent(
        '/Users/test/.claude',
        fiveHourEvent({ status: 'rejected', utilization: 100 }),
      );
      expect(h.notifications).toHaveLength(0);
    });

    it('does not fire 7-day notifications when seven_day_notifications_enabled=false', () => {
      h.service.recordEvent('/Users/test/.claude', {
        status: 'allowed',
        rateLimitType: 'seven_day',
        utilization: 80,
        resetsAt: 1_700_500_000,
      });
      expect(h.notifications).toHaveLength(0);
    });

    it('fires 7-day notifications when seven_day_notifications_enabled=true', () => {
      h.service.updateSettings({ seven_day_notifications_enabled: true });
      h.service.recordEvent('/Users/test/.claude', {
        status: 'allowed',
        rateLimitType: 'seven_day',
        utilization: 80,
        resetsAt: 1_700_500_000,
      });
      expect(h.notifications).toHaveLength(1);
    });

    it('still records 7-day snapshots even when notifications disabled', () => {
      h.service.recordEvent('/Users/test/.claude', {
        status: 'allowed',
        rateLimitType: 'seven_day',
        utilization: 80,
        resetsAt: 1_700_500_000,
      });
      const snaps = h.service.getSnapshots();
      expect(snaps).toHaveLength(1);
      expect(snaps[0].rate_limit_type).toBe('seven_day');
    });

    it('updates dedup table even when notifications disabled, so re-enabling does not flood', () => {
      h.service.updateSettings({ notifications_enabled: false });
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 80 }));
      h.service.updateSettings({ notifications_enabled: true });
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 85 }));

      // Even after re-enabling, 75% should NOT fire because the dedup row was
      // recorded during the disabled period.
      expect(h.notifications).toHaveLength(0);
    });
  });

  describe('multi-account', () => {
    it('tracks snapshots and thresholds independently per account', () => {
      const accounts = [
        makeAccount({ id: 1, name: 'Personal', config_dir: '/p/.claude' }),
        makeAccount({ id: 2, name: 'Work', config_dir: '/w/.claude' }),
      ];
      const h2 = makeHarness({ accounts });

      h2.service.recordEvent('/p/.claude', fiveHourEvent({ utilization: 80 }));
      h2.service.recordEvent('/w/.claude', fiveHourEvent({ utilization: 80 }));

      const snaps = h2.service.getSnapshots();
      expect(snaps).toHaveLength(2);
      const names = snaps.map((s) => s.account_name).sort();
      expect(names).toEqual(['Personal', 'Work']);

      // Each account fires its own 75% notification
      expect(h2.notifications).toHaveLength(2);
      h2.db.close();
    });

    it('getSnapshotsByAccount filters correctly', () => {
      const accounts = [
        makeAccount({ id: 1, name: 'Personal', config_dir: '/p/.claude' }),
        makeAccount({ id: 2, name: 'Work', config_dir: '/w/.claude' }),
      ];
      const h2 = makeHarness({ accounts });

      h2.service.recordEvent('/p/.claude', fiveHourEvent({ utilization: 30 }));
      h2.service.recordEvent('/w/.claude', fiveHourEvent({ utilization: 40 }));

      const personal = h2.service.getSnapshotsByAccount('Personal');
      expect(personal).toHaveLength(1);
      expect(personal[0].utilization).toBe(30);

      h2.db.close();
    });
  });

  describe('observed_at staleness', () => {
    it('records the current time on each event', () => {
      h.setNow(1_700_000_000_000);
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 30 }));
      const snaps = h.service.getSnapshots();
      expect(snaps[0].observed_at).toBe(1_700_000_000_000);

      h.setNow(1_700_000_300_000);
      h.service.recordEvent('/Users/test/.claude', fiveHourEvent({ utilization: 35 }));
      const snaps2 = h.service.getSnapshots();
      expect(snaps2[0].observed_at).toBe(1_700_000_300_000);
    });
  });
});

// Suppress unused-warning if vi import happens to be unreferenced
void vi;

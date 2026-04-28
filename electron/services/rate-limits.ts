import type { Database } from './database';
import type { AccountsService } from './accounts';
import type { NotificationsService } from './notifications';
import type { LoggingService } from './logging';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RateLimitType =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'overage';

export type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';

/**
 * Shape that mirrors `SDKRateLimitInfo` from `@anthropic-ai/claude-agent-sdk`.
 * We accept the SDK value directly via `recordEvent`; this re-declared type
 * keeps the service free of an SDK dependency for testing. `rateLimitType`
 * is widened to `string` so future SDK values pass through unchanged.
 */
export interface RateLimitInfo {
  status: RateLimitStatus;
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
  surpassedThreshold?: number;
}

export interface RateLimitSnapshot {
  account_name: string;
  rate_limit_type: string;
  status: RateLimitStatus;
  utilization: number | null;
  resets_at: number | null;
  observed_at: number;
}

export interface RateLimitSettings {
  notifications_enabled: boolean;
  five_hour_thresholds_pct: number[];
  seven_day_notifications_enabled: boolean;
  seven_day_thresholds_pct: number[];
  sound_enabled: boolean;
}

export interface RateLimitsService {
  recordEvent(configDir: string, info: RateLimitInfo): void;
  /**
   * Update utilization (and reset time) for a window without overwriting the
   * SDK-derived `status`. Called by the usage-runner when fresh /usage data
   * arrives. If no snapshot exists yet, creates one with `status: 'allowed'`.
   */
  recordUtilization(
    configDir: string,
    rateLimitType: string,
    utilization: number,
    resetsAt: number | null,
  ): void;
  getSnapshots(): RateLimitSnapshot[];
  getSnapshotsByAccount(accountName: string): RateLimitSnapshot[];
  getSettings(): RateLimitSettings;
  updateSettings(partial: Partial<RateLimitSettings>): RateLimitSettings;
}

export interface RateLimitsDeps {
  db: Database;
  accounts: AccountsService;
  notifications: Pick<NotificationsService, 'show'>;
  sendToRenderer: (channel: string, payload: unknown) => void;
  logging?: LoggingService | null;
  /** Override for tests so we can drive time forward deterministically. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'rate_limit_settings';

const DEFAULT_SETTINGS: RateLimitSettings = {
  notifications_enabled: true,
  five_hour_thresholds_pct: [75, 90],
  seven_day_notifications_enabled: false,
  seven_day_thresholds_pct: [75, 90],
  sound_enabled: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseSettings(raw: string | null): RateLimitSettings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<RateLimitSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      five_hour_thresholds_pct: Array.isArray(parsed.five_hour_thresholds_pct)
        ? parsed.five_hour_thresholds_pct.filter((n): n is number => typeof n === 'number')
        : DEFAULT_SETTINGS.five_hour_thresholds_pct,
      seven_day_thresholds_pct: Array.isArray(parsed.seven_day_thresholds_pct)
        ? parsed.seven_day_thresholds_pct.filter((n): n is number => typeof n === 'number')
        : DEFAULT_SETTINGS.seven_day_thresholds_pct,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function thresholdsForType(
  rateLimitType: string,
  settings: RateLimitSettings,
): number[] {
  if (rateLimitType === 'five_hour') return settings.five_hour_thresholds_pct;
  if (rateLimitType.startsWith('seven_day')) return settings.seven_day_thresholds_pct;
  return [];
}

function notificationsEnabledForType(
  rateLimitType: string,
  settings: RateLimitSettings,
): boolean {
  if (!settings.notifications_enabled) return false;
  if (rateLimitType === 'five_hour') return true;
  if (rateLimitType.startsWith('seven_day')) return settings.seven_day_notifications_enabled;
  return false;
}

function humanType(rateLimitType: string): string {
  if (rateLimitType === 'five_hour') return '5-hour';
  if (rateLimitType === 'seven_day') return '7-day';
  if (rateLimitType === 'seven_day_opus') return '7-day Opus';
  if (rateLimitType === 'seven_day_sonnet') return '7-day Sonnet';
  return rateLimitType.replace(/_/g, ' ');
}

function formatResetTime(resetsAt: number | null | undefined, nowMs: number): string {
  if (!resetsAt) return '';
  const remainingMs = resetsAt * 1000 - nowMs;
  if (remainingMs <= 0) return 'now';
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  const hrs = hours % 24;
  return `${days}d ${hrs}h`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRateLimitsService(deps: RateLimitsDeps): RateLimitsService {
  const { db, accounts, notifications, sendToRenderer, logging } = deps;
  const now = deps.now ?? (() => Date.now());

  function logWarn(message: string, metadata?: Record<string, unknown>): void {
    if (!logging) return;
    try {
      logging.writeBatch([
        {
          timestamp: new Date().toISOString(),
          level: 'warn',
          source: 'rate-limits',
          message,
          metadata: metadata ? JSON.stringify(metadata) : undefined,
        },
      ]);
    } catch {
      // never let logging failures escape
    }
  }

  function logDebug(message: string, metadata?: Record<string, unknown>): void {
    if (!logging) return;
    try {
      logging.writeBatch([
        {
          timestamp: new Date().toISOString(),
          level: 'debug',
          source: 'rate-limits',
          message,
          metadata: metadata ? JSON.stringify(metadata) : undefined,
        },
      ]);
    } catch {
      // never let logging failures escape
    }
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  function getSettings(): RateLimitSettings {
    return safeParseSettings(db.getSetting(SETTINGS_KEY));
  }

  function updateSettings(partial: Partial<RateLimitSettings>): RateLimitSettings {
    const current = getSettings();
    const next: RateLimitSettings = { ...current, ...partial };
    db.saveSetting(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  function upsertSnapshot(
    accountName: string,
    info: RateLimitInfo,
    rateLimitType: string,
    observedAt: number,
  ): void {
    // The SDK does not always include `utilization` (or `resetsAt`) on every
    // rate_limit_event — observed in practice on max-plan accounts where many
    // events arrive with `status: 'allowed'` and only the reset time. Use
    // COALESCE so an incoming null leaves the previous good value intact;
    // otherwise the widget would show "?%" right after a fresh percentage
    // reading just because the next event omitted it.
    db.raw
      .prepare(
        `INSERT INTO rate_limit_snapshots
           (account_name, rate_limit_type, status, utilization, resets_at, payload_json, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_name, rate_limit_type)
         DO UPDATE SET
           status = excluded.status,
           utilization = COALESCE(excluded.utilization, rate_limit_snapshots.utilization),
           resets_at = COALESCE(excluded.resets_at, rate_limit_snapshots.resets_at),
           payload_json = excluded.payload_json,
           observed_at = excluded.observed_at`,
      )
      .run(
        accountName,
        rateLimitType,
        info.status,
        info.utilization ?? null,
        info.resetsAt ?? null,
        JSON.stringify(info),
        observedAt,
      );
  }

  function getSnapshots(): RateLimitSnapshot[] {
    return db.raw
      .prepare(
        `SELECT account_name, rate_limit_type, status, utilization, resets_at, observed_at
         FROM rate_limit_snapshots
         ORDER BY account_name, rate_limit_type`,
      )
      .all() as RateLimitSnapshot[];
  }

  function getSnapshotsByAccount(accountName: string): RateLimitSnapshot[] {
    return db.raw
      .prepare(
        `SELECT account_name, rate_limit_type, status, utilization, resets_at, observed_at
         FROM rate_limit_snapshots
         WHERE account_name = ?
         ORDER BY rate_limit_type`,
      )
      .all(accountName) as RateLimitSnapshot[];
  }

  function recordUtilization(
    configDir: string,
    rateLimitType: string,
    utilization: number,
    resetsAt: number | null,
  ): void {
    const account = accounts.listAccounts().find((a) => a.config_dir === configDir);
    if (!account) {
      logWarn('recordUtilization: unknown configDir', { configDir });
      return;
    }
    const observedAt = now();
    // Update only utilization + resets_at; preserve status (and create with
    // status='allowed' when no row exists yet).
    db.raw
      .prepare(
        `INSERT INTO rate_limit_snapshots
           (account_name, rate_limit_type, status, utilization, resets_at, payload_json, observed_at)
         VALUES (?, ?, 'allowed', ?, ?, ?, ?)
         ON CONFLICT(account_name, rate_limit_type)
         DO UPDATE SET
           utilization = excluded.utilization,
           resets_at = COALESCE(excluded.resets_at, rate_limit_snapshots.resets_at),
           observed_at = excluded.observed_at`,
      )
      .run(
        account.name,
        rateLimitType,
        utilization,
        resetsAt,
        JSON.stringify({ source: 'usage_cli', utilization, resetsAt }),
        observedAt,
      );
    // Emit the persisted row (status preserved from any prior SDK event)
    // on the same channel + shape the SDK-event path uses, so the renderer's
    // single `rate-limits:updated` listener picks up CLI-runner refreshes.
    const merged = db.raw
      .prepare(
        `SELECT account_name, rate_limit_type, status, utilization, resets_at, observed_at
         FROM rate_limit_snapshots
         WHERE account_name = ? AND rate_limit_type = ?`,
      )
      .get(account.name, rateLimitType) as RateLimitSnapshot | undefined;
    sendToRenderer('rate-limits:updated', {
      account_name: account.name,
      snapshot: merged ?? {
        account_name: account.name,
        rate_limit_type: rateLimitType,
        status: 'allowed',
        utilization,
        resets_at: resetsAt,
        observed_at: observedAt,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Threshold dedup
  // -------------------------------------------------------------------------

  function hasFired(
    accountName: string,
    rateLimitType: string,
    windowResetsAt: number,
    thresholdKey: string,
  ): boolean {
    const row = db.raw
      .prepare(
        `SELECT 1 FROM rate_limit_fired_thresholds
         WHERE account_name = ? AND rate_limit_type = ?
           AND window_resets_at = ? AND threshold_key = ?`,
      )
      .get(accountName, rateLimitType, windowResetsAt, thresholdKey);
    return !!row;
  }

  function markFired(
    accountName: string,
    rateLimitType: string,
    windowResetsAt: number,
    thresholdKey: string,
    firedAt: number,
  ): void {
    db.raw
      .prepare(
        `INSERT OR IGNORE INTO rate_limit_fired_thresholds
           (account_name, rate_limit_type, window_resets_at, threshold_key, fired_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(accountName, rateLimitType, windowResetsAt, thresholdKey, firedAt);
  }

  // -------------------------------------------------------------------------
  // Notification dispatch
  // -------------------------------------------------------------------------

  function fireNotification(
    title: string,
    body: string,
    isError: boolean,
    enabled: boolean,
  ): void {
    if (!enabled) return;
    notifications.show(title, body, isError);
  }

  function checkThresholds(
    accountName: string,
    info: RateLimitInfo,
    rateLimitType: string,
    observedAt: number,
  ): void {
    const settings = getSettings();
    const enabled = notificationsEnabledForType(rateLimitType, settings);
    const window = info.resetsAt ?? 0;
    const human = humanType(rateLimitType);
    const tail = info.resetsAt ? ` — resets in ${formatResetTime(info.resetsAt, observedAt)}` : '';

    // 1. SDK-rejected: highest urgency, distinct copy
    if (info.status === 'rejected') {
      const key = 'sdk_rejected';
      if (!hasFired(accountName, rateLimitType, window, key)) {
        markFired(accountName, rateLimitType, window, key, observedAt);
        const body = `${accountName} · ${human} limit hit${tail}`;
        fireNotification(`Rate limit hit`, body, true, enabled);
      }
      return;
    }

    // 2. SDK-warning signal: fire once per window regardless of percent
    if (info.status === 'allowed_warning') {
      const key = 'sdk_warning';
      if (!hasFired(accountName, rateLimitType, window, key)) {
        markFired(accountName, rateLimitType, window, key, observedAt);
        const body = `${accountName} · ${human} usage approaching limit (Anthropic warning)${tail}`;
        fireNotification(`Rate limit warning`, body, false, enabled);
      }
    }

    // 3. User-configured percent thresholds
    if (typeof info.utilization === 'number') {
      const thresholds = thresholdsForType(rateLimitType, settings)
        .slice()
        .sort((a, b) => a - b);
      for (const pct of thresholds) {
        if (info.utilization < pct) continue;
        const key = `pct_${pct}`;
        if (hasFired(accountName, rateLimitType, window, key)) continue;
        markFired(accountName, rateLimitType, window, key, observedAt);
        const body = `${accountName} · ${human} usage at ${pct}%${tail}`;
        fireNotification(`Rate limit ${pct}%`, body, false, enabled);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Account resolution
  // -------------------------------------------------------------------------

  function resolveAccountName(configDir: string): string | null {
    const account = accounts.listAccounts().find((a) => a.config_dir === configDir);
    return account?.name ?? null;
  }

  // -------------------------------------------------------------------------
  // recordEvent — main entry point
  // -------------------------------------------------------------------------

  function recordEvent(configDir: string, info: RateLimitInfo): void {
    const accountName = resolveAccountName(configDir);
    if (!accountName) {
      logWarn(`rate-limits: ignoring event for unknown configDir`, { configDir });
      return;
    }

    if (!info.rateLimitType) {
      // Some events arrive without a typed window — record under a generic
      // key so we don't drop the data, but skip threshold detection.
      logWarn(`rate-limits: event missing rateLimitType`, { accountName });
      return;
    }

    const observedAt = now();

    logDebug(`recordEvent`, {
      accountName,
      rateLimitType: info.rateLimitType,
      status: info.status,
      utilization: info.utilization ?? null,
      resetsAt: info.resetsAt ?? null,
      surpassedThreshold: info.surpassedThreshold ?? null,
    });

    upsertSnapshot(accountName, info, info.rateLimitType, observedAt);
    checkThresholds(accountName, info, info.rateLimitType, observedAt);

    // Emit the persisted (sticky-merged) row, not the raw incoming event,
    // so the renderer sees the COALESCE'd utilization / resets_at.
    const merged = db.raw
      .prepare(
        `SELECT account_name, rate_limit_type, status, utilization, resets_at, observed_at
         FROM rate_limit_snapshots
         WHERE account_name = ? AND rate_limit_type = ?`,
      )
      .get(accountName, info.rateLimitType) as RateLimitSnapshot | undefined;

    sendToRenderer('rate-limits:updated', {
      account_name: accountName,
      snapshot: merged ?? {
        account_name: accountName,
        rate_limit_type: info.rateLimitType,
        status: info.status,
        utilization: info.utilization ?? null,
        resets_at: info.resetsAt ?? null,
        observed_at: observedAt,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Manual refresh via `claude -p "/status" --output-format json`
  // -------------------------------------------------------------------------

  return {
    recordEvent,
    recordUtilization,
    getSnapshots,
    getSnapshotsByAccount,
    getSettings,
    updateSettings,
  };
}

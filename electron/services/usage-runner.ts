import os from 'node:os';
import type { AccountsService } from './accounts';
import type { RateLimitsService } from './rate-limits';
import { findClaudeBinary as defaultFindClaudeBinary } from './util/find-claude-binary';
import { stripAnsi } from './usage-runner/ansi';
import { parseUsageOutput, isUsageOutputComplete, type UsageData } from './usage-runner/parser';
import { resetsLabelToEpoch } from './usage-runner/resets-label';
import type { LoggingService } from './logging';

export interface FakePty {
  write(data: string): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: { exitCode: number }) => void): void;
}

export type PtySpawner = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number },
) => FakePty;

export type UsageRunResult =
  | { ok: true; observed_at: number; raw: string; parsed: UsageData }
  | { ok: false; observed_at: number; error: string; raw?: string };

export interface UsageRunnerService {
  run(accountName: string): Promise<UsageRunResult>;
  getLast(accountName: string): UsageRunResult | null;
}

export interface UsageRunnerDeps {
  accounts: AccountsService;
  rateLimits: RateLimitsService;
  spawnPty?: PtySpawner;
  findClaudeBinary?: () => string | null;
  now?: () => number;
  logging?: LoggingService | null;
  // Tunables (defaults match the spec)
  settleQuietMs?: number;
  usageQuietMs?: number;
  /**
   * After the captured text first looks fully rendered (all three windows +
   * Resets lines), wait this many extra ms in case more bytes are still
   * inbound. Defaults to 200ms.
   */
  fullRenderQuietMs?: number;
  hardTimeoutMs?: number;
  killGraceMs?: number;
}

const PARSER_LABEL_TO_RATE_LIMIT_TYPE: Record<UsageData['windows'][number]['label'], string> = {
  current_session: 'five_hour',
  week_all_models: 'seven_day',
  week_sonnet: 'seven_day_sonnet',
};

// Plausibility caps per window. The 5h window maxes at 5 hours from now and
// the 7d window at 7 days; we add a small margin to absorb clock skew + the
// time spent rendering and capturing the TUI output before stamping
// `observedAt`. Anything beyond the cap is treated as a parse glitch (the
// classic case is a relative-format parser swallowing leftover digits and
// computing "in 500h" or similar).
const FIVE_HOUR_CAP_MS = 6 * 60 * 60 * 1000;
const SEVEN_DAY_CAP_MS = 8 * 24 * 60 * 60 * 1000;

function validateResetEpoch(
  epochMs: number | null,
  label: UsageData['windows'][number]['label'],
  observedAtMs: number,
): { accepted: number | null; reason: string } {
  if (epochMs == null) return { accepted: null, reason: 'unparseable' };
  const dt = epochMs - observedAtMs;
  if (dt <= 0) return { accepted: null, reason: 'in_past' };
  const cap = label === 'current_session' ? FIVE_HOUR_CAP_MS : SEVEN_DAY_CAP_MS;
  if (dt > cap) return { accepted: null, reason: `beyond_cap (dt=${dt}ms cap=${cap}ms)` };
  return { accepted: epochMs, reason: 'ok' };
}

export function createUsageRunnerService(deps: UsageRunnerDeps): UsageRunnerService {
  const spawnPty = deps.spawnPty ?? defaultSpawnPty;
  const findBinary = deps.findClaudeBinary ?? (() => defaultFindClaudeBinary());
  const now = deps.now ?? Date.now;
  const settleQuietMs = deps.settleQuietMs ?? 750;
  const usageQuietMs = deps.usageQuietMs ?? 1500;
  const fullRenderQuietMs = deps.fullRenderQuietMs ?? 200;
  const hardTimeoutMs = deps.hardTimeoutMs ?? 20000;
  const killGraceMs = deps.killGraceMs ?? 500;

  const inFlight = new Map<string, Promise<UsageRunResult>>();
  const cache = new Map<string, UsageRunResult>();

  function logAt(level: 'info' | 'warn', msg: string, ctx?: Record<string, unknown>): void {
    if (!deps.logging) return;
    try {
      deps.logging.writeBatch([
        {
          timestamp: new Date().toISOString(),
          level,
          source: 'usage-runner',
          message: msg,
          metadata: ctx ? JSON.stringify(ctx) : undefined,
        },
      ]);
    } catch {
      // never let logging failures escape
    }
  }
  function logWarn(msg: string, ctx?: Record<string, unknown>): void { logAt('warn', msg, ctx); }
  function logInfo(msg: string, ctx?: Record<string, unknown>): void { logAt('info', msg, ctx); }

  async function run(accountName: string): Promise<UsageRunResult> {
    const existing = inFlight.get(accountName);
    if (existing) return existing;

    const account = deps.accounts.listAccounts().find((a) => a.name === accountName);
    if (!account) {
      const r: UsageRunResult = { ok: false, observed_at: now(), error: `Unknown account: ${accountName}` };
      return cacheAndReturn(accountName, r);
    }

    const binary = account.cli_path && account.cli_path.length > 0
      ? account.cli_path
      : findBinary();
    if (!binary) {
      const r: UsageRunResult = { ok: false, observed_at: now(), error: 'claude binary not found' };
      return cacheAndReturn(accountName, r);
    }

    const promise = doRun(accountName, account.config_dir, binary)
      .finally(() => { inFlight.delete(accountName); });
    inFlight.set(accountName, promise);
    return promise;
  }

  async function doRun(
    accountName: string,
    configDir: string,
    binary: string,
  ): Promise<UsageRunResult> {
    const observedAt = now();
    let pty: FakePty;
    try {
      pty = spawnPty(binary, [], {
        cwd: os.homedir(),
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        cols: 200,
        rows: 60,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn('spawn failed', { binary, error: msg });
      return cacheAndReturn(accountName, {
        ok: false, observed_at: observedAt, error: `spawn failed: ${msg}`,
      });
    }

    let buffer = '';
    let lastByteAt = Date.now();
    pty.onData((chunk) => {
      buffer += chunk;
      lastByteAt = Date.now();
    });
    let exited = false;
    pty.onExit(() => { exited = true; });

    const hardDeadline = Date.now() + hardTimeoutMs;

    // Phase 1: navigate past startup until we reach the welcome/prompt
    // screen. Two transient screens can appear first:
    //   - Workspace-trust dialog (when cwd hasn't been trusted yet for
    //     this config dir). Default-highlighted choice is "Yes, I trust
    //     this folder" — pressing Enter confirms.
    //   - Welcome screen with the input prompt and a "? for shortcuts"
    //     footer that's our reliable "ready" signal.
    //
    // We wait for the welcome footer to appear; if we see the trust
    // dialog before then, we send Enter once to confirm and keep waiting.
    // The earlier heuristic of "wait for `❯` then quiet" was wrong — the
    // trust dialog uses `❯` as its highlight cursor, so it triggered
    // immediately and we sent /usage into the dialog.
    const READY_MARKER = 'for shortcuts';
    const TRUST_MARKER = 'trust this folder';
    let trustConfirmed = false;
    while (Date.now() < hardDeadline) {
      const stripped = stripAnsi(buffer);
      const ready = stripped.includes(READY_MARKER);
      const quiet = Date.now() - lastByteAt >= settleQuietMs;
      if (ready && quiet) break;
      if (!trustConfirmed && stripped.includes(TRUST_MARKER)) {
        pty.write('\r');
        trustConfirmed = true;
      }
      if (exited) break;
      await sleep(50);
    }
    if (exited || Date.now() >= hardDeadline) {
      try { pty.kill(); } catch { /* already gone */ }
      return cacheAndReturn(accountName, {
        ok: false, observed_at: observedAt, error: 'pty exited or timed out before prompt was ready',
        raw: stripAnsi(buffer),
      });
    }

    // Phase 2: send /usage
    const beforeUsage = buffer.length;
    pty.write('/usage\r');

    // Phase 3: wait for /usage rendering to settle. Fast path: as soon as
    // the captured text passes `isUsageOutputComplete` (all three windows
    // present, each with a Resets line), give it a short additional quiet
    // window (`fullRenderQuietMs`) to absorb any trailing bytes, then exit.
    // Slow path: if the render is incomplete or unrecognized, fall back to
    // the existing "quiet for `usageQuietMs`" timeout — a partial snapshot
    // is still emitted so the user gets *something*, but the new sanity
    // bounds + COALESCE in `recordUtilization` keep junk out of storage.
    let lastSeenLen = beforeUsage;
    let stableSince = Date.now();
    let completeSince: number | null = null;
    while (Date.now() < hardDeadline) {
      if (buffer.length !== lastSeenLen) {
        lastSeenLen = buffer.length;
        stableSince = Date.now();
        completeSince = null;
      }
      if (buffer.length > beforeUsage) {
        if (completeSince == null && isUsageOutputComplete(stripAnsi(buffer.slice(beforeUsage)))) {
          completeSince = Date.now();
        }
        if (completeSince != null && Date.now() - completeSince >= fullRenderQuietMs) break;
        if (Date.now() - stableSince >= usageQuietMs) break;
      }
      if (exited) break;
      await sleep(20);
    }

    // Phase 4: clean up
    try { pty.write('/quit\r'); } catch { /* ignore */ }
    setTimeout(() => { try { pty.kill(); } catch { /* already gone */ } }, killGraceMs);

    const raw = stripAnsi(buffer.slice(beforeUsage));
    const parsed = parseUsageOutput(raw);
    if (!parsed.ok) {
      return cacheAndReturn(accountName, {
        ok: false, observed_at: observedAt, error: `parse_failed: ${parsed.reason}`, raw,
      });
    }
    // Dual-write to rate-limits — convert the human label ("Resets 7pm
    // (America/New_York)" or "in 5h") to an absolute epoch (seconds) so the
    // 7-day/5-hour pills can render the same countdown the 5-hour widget
    // already shows from claude-stream events. Pass null when the label is
    // empty, unparseable, or implausibly far away — `recordUtilization`
    // COALESCEs null against the prior good value so a junk parse never
    // clobbers a known-good reset time.
    for (const w of parsed.data.windows) {
      const type = PARSER_LABEL_TO_RATE_LIMIT_TYPE[w.label];
      const resetsEpochMs = resetsLabelToEpoch(w.resets_at_label, observedAt);
      const validation = validateResetEpoch(resetsEpochMs, w.label, observedAt);
      const resetsAtSec = validation.accepted == null ? null : Math.floor(validation.accepted / 1000);

      const logCtx = {
        account: accountName,
        window: w.label,
        rate_limit_type: type,
        raw_label: w.resets_at_label,
        parsed_epoch_ms: resetsEpochMs,
        observed_at_ms: observedAt,
        accepted: validation.accepted != null,
        reason: validation.reason,
      };
      if (validation.reason === 'ok') {
        logInfo('parsed reset epoch', logCtx);
      } else {
        logWarn('rejected reset epoch — preserving prior good value', logCtx);
      }

      deps.rateLimits.recordUtilization(configDir, type, w.pct_used, resetsAtSec);
    }
    return cacheAndReturn(accountName, {
      ok: true, observed_at: observedAt, raw, parsed: parsed.data,
    });
  }

  function cacheAndReturn(accountName: string, result: UsageRunResult): UsageRunResult {
    const prior = cache.get(accountName);
    // Don't replace a prior ok:true with an ok:false
    if (result.ok || !prior || !prior.ok) cache.set(accountName, result);
    return result;
  }

  function getLast(accountName: string): UsageRunResult | null {
    return cache.get(accountName) ?? null;
  }

  return { run, getLast };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function defaultSpawnPty(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number },
): FakePty {
  // Inline import so node-pty isn't loaded unless actually used.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ptyModule = require('node-pty');
  const pty = ptyModule.spawn(command, args, opts);
  return {
    write: (d) => pty.write(d),
    kill: () => pty.kill(),
    onData: (cb) => { pty.onData(cb); },
    onExit: (cb) => {
      pty.onExit((evt: { exitCode?: number }) => cb({ exitCode: evt.exitCode ?? 0 }));
    },
  };
}

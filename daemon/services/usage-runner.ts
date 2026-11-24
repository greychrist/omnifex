import type { AccountsService } from './accounts';
import type { RateLimitsService } from './rate-limits';
import { stripAnsi } from './usage-runner/ansi';
import {
  parseUsageOutput,
  isUsageOutputComplete,
  collectUsageDriftWarnings,
  rateLimitTypeForWindow,
  type UsageData,
} from './usage-runner/parser';
import { resetsLabelToEpoch, CLOCK_LABEL_GRACE_MS } from './usage-runner/resets-label';
import { ensureTrustedScratchCwd } from './usage-runner/scratch-cwd';
import type { LoggingService } from './logging';
import { buildClaudeEnv } from './util/claude-env';

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
  findClaudeBinary: () => string | null;
  now?: () => number;
  logging?: LoggingService | null;
  /** The cwd must be pre-trusted: the home dir trips the CLI's first-launch safety dialog, which the pty cannot answer. */
  ensureCwd?: (accountKey: string, configDir: string) => string;
  userDataDir?: string;
  settleQuietMs?: number;
  usageQuietMs?: number;
  fullRenderQuietMs?: number;
  /** The CLI can redraw a bar over a "Refreshing…" placeholder after the screen has gone quiet. */
  incompleteParseGraceMs?: number;
  /** Behind "Loading usage data" the CLI async-loads windows and can send no bytes for seconds. Capped at hardTimeoutMs. */
  loadingDataGraceMs?: number;
  hardTimeoutMs?: number;
  killGraceMs?: number;
}

const LOADING_DATA_MARKER = 'Loading usage data';

// Beyond the window length plus a margin, a reset is a parse glitch (leftover digits read as "in 500h").
const FIVE_HOUR_CAP_MS = 6 * 60 * 60 * 1000;
const SEVEN_DAY_CAP_MS = 8 * 24 * 60 * 60 * 1000;

function validateResetEpoch(
  epochMs: number | null,
  label: string,
  observedAtMs: number,
  rawLabel: string,
): { accepted: number | null; reason: string } {
  if (epochMs == null) {
    // Only an unparseable label is drift; an absent one is routine.
    return { accepted: null, reason: rawLabel.trim() ? 'unparseable' : 'absent' };
  }
  const dt = epochMs - observedAtMs;
  if (dt < -CLOCK_LABEL_GRACE_MS) return { accepted: null, reason: 'in_past' };
  const cap = label === 'current_session' ? FIVE_HOUR_CAP_MS : SEVEN_DAY_CAP_MS;
  if (dt > cap) return { accepted: null, reason: `beyond_cap (dt=${dt}ms cap=${cap}ms)` };
  return { accepted: Math.max(epochMs, observedAtMs), reason: 'ok' };
}

export function createUsageRunnerService(deps: UsageRunnerDeps): UsageRunnerService {
  const spawnPty = deps.spawnPty ?? defaultSpawnPty;
  const findBinary = deps.findClaudeBinary;
  const now = deps.now ?? Date.now;
  const settleQuietMs = deps.settleQuietMs ?? 750;
  const usageQuietMs = deps.usageQuietMs ?? 1500;
  const fullRenderQuietMs = deps.fullRenderQuietMs ?? 200;
  const incompleteParseGraceMs = deps.incompleteParseGraceMs ?? 3000;
  const loadingDataGraceMs = deps.loadingDataGraceMs ?? 12000;
  const hardTimeoutMs = deps.hardTimeoutMs ?? 20000;
  const killGraceMs = deps.killGraceMs ?? 500;
  const ensureCwd: (accountKey: string, configDir: string) => string =
    deps.ensureCwd ?? ((accountKey, configDir) => {
      if (!deps.userDataDir) {
        throw new Error(
          'usage-runner: either `ensureCwd` or `userDataDir` must be provided',
        );
      }
      return ensureTrustedScratchCwd(accountKey, configDir, {
        userDataDir: deps.userDataDir,
      });
    });

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

    // A failed trust setup must surface, never launch into the safety dialog.
    let cwd: string;
    try {
      cwd = ensureCwd(accountName, configDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn('ensureCwd failed — cannot resolve trusted scratch dir', {
        account: accountName, configDir, error: msg,
      });
      return cacheAndReturn(accountName, {
        ok: false, observed_at: observedAt, error: `ensureCwd failed: ${msg}`,
      });
    }

    logInfo('run start', { account: accountName, configDir, binary, cwd });

    let pty: FakePty;
    try {
      // No MCP servers: each would spawn by bare name only to be killed (PATH-probe storm).
      // --mcp-config alone merges; only --strict-mcp-config makes the empty set authoritative.
      pty = spawnPty(binary, ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], {
        cwd,
        env: buildClaudeEnv(configDir),
        cols: 200,
        // stripAnsi returns the screen, so rows below the fold are lost; 60 rows dropped the tables.
        rows: 200,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn('spawn failed', { binary, cwd, error: msg });
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

    // The trust dialog also uses `❯`, so wait for a footer marker, not the cursor. The footer wording drifts: add markers here.
    // The banner places words with cursor escapes, so spaces vanish after stripAnsi; match compacted text.
    const READY_MARKERS = ['for shortcuts', 'shift+tab to cycle'];
    const TRUST_MARKER = 'trust this folder';
    // Interstitials that replace the welcome footer. Always Esc: a read-only scrape must never change the user's config.
    const ESC_DISMISSIBLE: { id: string; marker: string; why: string }[] = [
      {
        // Enter would opt the account into browser tools.
        id: 'chrome_extension',
        marker: 'chrome extension detected',
        why: 'keeps browser tools off',
      },
      {
        // Enter starts a trial that persists `tui: "fullscreen"` into settings.json.
        id: 'fullscreen_offer',
        marker: 'try the new fullscreen renderer',
        why: 'leaves the renderer choice to the user',
      },
    ];
    const compact = (s: string) => s.replace(/\s+/g, '');
    const COMPACT_READY_MARKERS = READY_MARKERS.map(compact);
    const COMPACT_TRUST_MARKER = compact(TRUST_MARKER);
    const COMPACT_DISMISSIBLE = ESC_DISMISSIBLE.map((d) => ({
      ...d,
      compactMarker: compact(d.marker).toLowerCase(),
    }));
    let trustConfirmed = false;
    const dismissed = new Set<string>();
    let readyLogged = false;
    while (Date.now() < hardDeadline) {
      const stripped = stripAnsi(buffer);
      const compactStripped = compact(stripped);
      const ready = COMPACT_READY_MARKERS.some((m) => compactStripped.includes(m));
      const quiet = Date.now() - lastByteAt >= settleQuietMs;
      if (ready && quiet) {
        if (!readyLogged) {
          logInfo('welcome ready — about to send /usage', { account: accountName });
          readyLogged = true;
        }
        break;
      }
      if (!trustConfirmed && compactStripped.includes(COMPACT_TRUST_MARKER)) {
        logWarn('trust dialog observed despite pre-trust — sending Enter', {
          account: accountName, cwd,
        });
        pty.write('\r');
        trustConfirmed = true;
      }
      const compactLower = compactStripped.toLowerCase();
      for (const d of COMPACT_DISMISSIBLE) {
        if (dismissed.has(d.id)) continue;
        if (!compactLower.includes(d.compactMarker)) continue;
        logInfo(`startup dialog observed (${d.id}) — sending Esc, which ${d.why}`, {
          account: accountName,
        });
        pty.write('\x1b');
        dismissed.add(d.id);
      }
      if (exited) break;
      await sleep(50);
    }
    if (exited || Date.now() >= hardDeadline) {
      const raw = stripAnsi(buffer);
      try { pty.kill(); } catch { /* already gone */ }
      logWarn('pty exited or timed out before prompt was ready', {
        account: accountName,
        cwd,
        configDir,
        exited,
        awaited_markers: READY_MARKERS,
        handled_dialogs: { trust: trustConfirmed, dismissed: [...dismissed] },
        dismissible_markers: ESC_DISMISSIBLE.map((d) => d.marker),
        screen: raw,
        raw,
      });
      return cacheAndReturn(accountName, {
        ok: false, observed_at: observedAt, error: 'pty exited or timed out before prompt was ready',
        raw,
      });
    }

    const beforeUsage = buffer.length;
    pty.write('/usage\r');
    logInfo('/usage sent — waiting for render', { account: accountName });

    let lastSeenLen = beforeUsage;
    let stableSince = Date.now();
    let completeSince: number | null = null;
    let graceLogged = false;
    const compactPty = (s: string): string => s.replace(/\s+/g, '');
    const COMPACT_LOADING_DATA = compactPty(LOADING_DATA_MARKER);
    while (Date.now() < hardDeadline) {
      if (buffer.length !== lastSeenLen) {
        lastSeenLen = buffer.length;
        stableSince = Date.now();
        completeSince = null;
        graceLogged = false;
      }
      if (buffer.length > beforeUsage) {
        const stripped = stripAnsi(buffer.slice(beforeUsage));
        if (completeSince == null && isUsageOutputComplete(stripped)) {
          completeSince = Date.now();
        }
        if (completeSince != null && Date.now() - completeSince >= fullRenderQuietMs) break;
        const seenLoading = compactPty(stripped).includes(COMPACT_LOADING_DATA);
        const grace = seenLoading ? loadingDataGraceMs : incompleteParseGraceMs;
        const quietFor = Date.now() - stableSince;
        if (quietFor >= usageQuietMs + grace) break;
        if (quietFor >= usageQuietMs && !graceLogged) {
          logInfo('parse incomplete — extending wait for late chunk', {
            account: accountName,
            quiet_for_ms: quietFor,
            grace_ms: grace,
            seen_loading_placeholder: seenLoading,
          });
          graceLogged = true;
        }
      }
      if (exited) break;
      await sleep(20);
    }

    try { pty.write('/quit\r'); } catch { /* ignore */ }
    setTimeout(() => { try { pty.kill(); } catch { /* already gone */ } }, killGraceMs);

    const raw = stripAnsi(buffer.slice(beforeUsage));
    logInfo('usage capture (pre-parse)', { account: accountName, raw });
    const parsed = parseUsageOutput(raw);
    if (!parsed.ok) {
      logWarn('parse failed', {
        account: accountName, reason: parsed.reason, raw,
      });
      return cacheAndReturn(accountName, {
        ok: false, observed_at: observedAt, error: `parse_failed: ${parsed.reason}`, raw,
      });
    }
    logInfo('parse ok', {
      account: accountName,
      windows: parsed.data.windows.map((w) => ({ label: w.label, pct: w.pct_used })),
    });
    const driftWarnings = collectUsageDriftWarnings(raw);
    if (driftWarnings.length > 0) {
      logWarn('usage output drift — parsed ok but expected labels missing (silent zeros likely)', {
        account: accountName, warnings: driftWarnings, raw,
      });
    }
    // Stale bars would get a fresh observed_at; the stored values already describe that earlier observation.
    if (parsed.data.stale) {
      logWarn('stale (last-known) usage render — skipping utilization dual-write', {
        account: accountName,
        windows: parsed.data.windows.map((w) => ({ label: w.label, pct: w.pct_used })),
      });
      return cacheAndReturn(accountName, {
        ok: true, observed_at: observedAt, raw, parsed: parsed.data,
      });
    }
    // null COALESCEs against the prior good value, so a junk parse never clobbers a known reset time.
    for (const w of parsed.data.windows) {
      const type = rateLimitTypeForWindow(w.label);
      const resetsEpochMs = resetsLabelToEpoch(w.resets_at_label, observedAt);
      const validation = validateResetEpoch(resetsEpochMs, w.label, observedAt, w.resets_at_label);
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
      } else if (validation.reason === 'absent') {
        logInfo('no reset label rendered for this window', logCtx);
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
    if (result.ok || !prior?.ok) cache.set(accountName, result);
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
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- inline lazy load; node-pty has heavy native deps.
  const ptyModule = require('node-pty') as typeof import('node-pty');
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

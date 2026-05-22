import type { AccountsService } from './accounts';
import type { RateLimitsService } from './rate-limits';
import { findClaudeBinary as defaultFindClaudeBinary } from './util/find-claude-binary';
import { stripAnsi } from './usage-runner/ansi';
import { parseUsageOutput, isUsageOutputComplete, type UsageData } from './usage-runner/parser';
import { resetsLabelToEpoch } from './usage-runner/resets-label';
import { ensureTrustedScratchCwd } from './usage-runner/scratch-cwd';
import { repairCorruptedWords } from './usage-runner/repair';
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
  findClaudeBinary?: () => string | null;
  now?: () => number;
  logging?: LoggingService | null;
  /**
   * Resolves the cwd to spawn Claude in for a given account. Prior versions
   * used `os.homedir()` and tripped Claude Code's first-launch safety
   * dialog ("Quick safety check: Is this a project you created…"), which
   * the pty automation couldn't recognize and timed out on. The default
   * production binding creates a per-account empty scratch dir under
   * `<userData>/usage-cwd/<accountKey>/` and pre-trusts it via
   * `<configDir>/.claude.json` — see ./usage-runner/scratch-cwd.ts.
   *
   * Tests inject a stub returning a fixed string so they don't touch real
   * filesystem state.
   */
  ensureCwd?: (accountKey: string, configDir: string) => string;
  /**
   * `app.getPath('userData')`. Used by the default `ensureCwd` binding;
   * ignored when a custom `ensureCwd` is provided.
   */
  userDataDir?: string;
  // Tunables (defaults match the spec)
  settleQuietMs?: number;
  usageQuietMs?: number;
  /**
   * After the captured text first looks fully rendered (all three windows +
   * Resets lines), wait this many extra ms in case more bytes are still
   * inbound. Defaults to 200ms.
   */
  fullRenderQuietMs?: number;
  /**
   * When the buffer goes quiet for `usageQuietMs` but the parse is
   * incomplete (fewer than all 3 windows), wait an additional grace
   * period for the missing block to arrive. As of Claude Code 2.1.132 the
   * Sonnet bar is rendered asynchronously via cursor redraws over a
   * "Refreshing…" placeholder, sometimes after the rest of the screen
   * has gone quiet. If the grace expires without completion, snapshot
   * what we have. Defaults to 3000ms.
   */
  incompleteParseGraceMs?: number;
  /**
   * When the buffer shows the literal "Loading usage data" placeholder AND
   * the parse is still incomplete, use this longer grace period instead of
   * `incompleteParseGraceMs`. Claude Code 2.1.146+ async-loads rate-limit
   * blocks from the server after rendering the Session block, and the
   * network call can sit quiet for many seconds with no pty bytes. The
   * standard 3s grace expires before the response arrives and we end up
   * snapshotting only the placeholder → `no_windows` parse failure on
   * every poll. Defaults to 12000ms, leaving headroom under the 20s hard
   * timeout. Capped at hardTimeoutMs at use site.
   */
  loadingDataGraceMs?: number;
  hardTimeoutMs?: number;
  killGraceMs?: number;
}

const LOADING_DATA_MARKER = 'Loading usage data';

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

    // Resolve a trusted cwd. If this throws (e.g. malformed .claude.json),
    // surface the error to the caller and the Log tab rather than
    // launching into the safety dialog.
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
      pty = spawnPty(binary, [], {
        cwd,
        env: buildClaudeEnv(configDir),
        cols: 200,
        rows: 60,
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
    // Welcome-footer markers. Claude Code's TUI footer text drifts across
    // versions, so we match a small set rather than a single fixed string:
    //   - `for shortcuts`           pre-2.1.132 ("? for shortcuts")
    //   - `shift+tab to cycle`      2.1.132+ ("⏵⏵ auto mode on (shift+tab to cycle) …")
    // Add new entries here when Claude rewords the footer again. The
    // failure mode is loud (timeout + raw buffer in Log tab), so the next
    // drift is easy to diagnose.
    // Claude Code 2.1.146 lays out parts of the banner with cursor-
    // positioning ANSI escapes (CUF, etc.) instead of literal space chars.
    // After stripAnsi the visible characters remain but the spaces are gone
    // (e.g. `shift+tab to cycle` arrives as `shift+tabtocycle`). Normalize
    // whitespace on both sides so the matcher survives any inter-word
    // spacing variant the TUI produces.
    const READY_MARKERS = ['for shortcuts', 'shift+tab to cycle'];
    const TRUST_MARKER = 'trust this folder';
    const compact = (s: string) => s.replace(/\s+/g, '');
    const COMPACT_READY_MARKERS = READY_MARKERS.map(compact);
    const COMPACT_TRUST_MARKER = compact(TRUST_MARKER);
    let trustConfirmed = false;
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
        // Defensive — the scratch-cwd helper pre-trusts the folder, so
        // this branch shouldn't fire under normal operation. If it does,
        // log it so we can tell whether the trust mark stopped sticking.
        logWarn('trust dialog observed despite pre-trust — sending Enter', {
          account: accountName, cwd,
        });
        pty.write('\r');
        trustConfirmed = true;
      }
      if (exited) break;
      await sleep(50);
    }
    if (exited || Date.now() >= hardDeadline) {
      const raw = stripAnsi(buffer);
      try { pty.kill(); } catch { /* already gone */ }
      logWarn('pty exited or timed out before prompt was ready', {
        account: accountName, cwd, configDir, exited, raw,
      });
      return cacheAndReturn(accountName, {
        ok: false, observed_at: observedAt, error: 'pty exited or timed out before prompt was ready',
        raw,
      });
    }

    // Phase 2: send /usage
    const beforeUsage = buffer.length;
    pty.write('/usage\r');
    logInfo('/usage sent — waiting for render', { account: accountName });

    // Phase 3: wait for /usage rendering to settle.
    //   - Fast path: as soon as the captured text passes
    //     `isUsageOutputComplete` (all three windows + Resets lines), give
    //     it a short additional quiet window (`fullRenderQuietMs`) and
    //     exit.
    //   - Patient path: if the buffer goes quiet for `usageQuietMs` but
    //     the parse is *incomplete*, keep waiting up to an additional
    //     `incompleteParseGraceMs` for the missing block — Claude
    //     sometimes async-renders the Sonnet bar after the rest has
    //     stilled. Re-arms whenever bytes arrive (so a slow-but-steady
    //     trickle continues to extend the wait until either completion
    //     or hard deadline).
    //   - Snapshot path: if grace expires without completion, take
    //     whatever we have. The downstream sanity bounds + COALESCE in
    //     `recordUtilization` keep junk out of storage.
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
        // Fast path — fully complete render.
        if (completeSince != null && Date.now() - completeSince >= fullRenderQuietMs) break;
        // Quiet for `usageQuietMs`. If the parse is also complete we
        // would have already broken via the fast path, so reaching here
        // means the parse is incomplete. The grace period depends on
        // whether the TUI is in its async-load state: when the literal
        // "Loading usage data" placeholder is visible (Claude Code
        // 2.1.146+), use the longer `loadingDataGraceMs` so the server
        // response has time to arrive. Otherwise use the standard grace.
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

    // Phase 4: clean up
    try { pty.write('/quit\r'); } catch { /* ignore */ }
    setTimeout(() => { try { pty.kill(); } catch { /* already gone */ } }, killGraceMs);

    const raw = stripAnsi(buffer.slice(beforeUsage));
    // Always log the raw pre-parse buffer so successful and failing runs
    // both leave an inspectable record. (The earlier code only logged
    // `raw` inside the parse-failure / timeout branches, so a parse that
    // technically "succeeded" but produced wrong numbers was invisible.)
    logInfo('usage capture (pre-parse)', { account: accountName, raw });
    // Vocabulary-driven repair: Claude's cursor-redraw drops single chars
    // (e.g. "sessions" → "sessi ns") but the same word usually appears
    // intact elsewhere in the buffer. See usage-runner/repair.ts.
    const repaired = repairCorruptedWords(raw);
    if (repaired !== raw) {
      logInfo('repaired corrupted words from buffer vocabulary', {
        account: accountName,
        before_len: raw.length,
        after_len: repaired.length,
      });
    }
    const parsed = parseUsageOutput(repaired);
    if (!parsed.ok) {
      logWarn('parse failed', {
        account: accountName, reason: parsed.reason, raw, repaired,
      });
      return cacheAndReturn(accountName, {
        ok: false, observed_at: observedAt, error: `parse_failed: ${parsed.reason}`, raw,
      });
    }
    logInfo('parse ok', {
      account: accountName,
      windows: parsed.data.windows.map((w) => ({ label: w.label, pct: w.pct_used })),
    });
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
  // Inline import so node-pty isn't loaded unless actually used.
   
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- inline lazy load; node-pty has heavy native deps.
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

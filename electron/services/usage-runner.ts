import os from 'node:os';
import type { AccountsService } from './accounts';
import type { RateLimitsService } from './rate-limits';
import { findClaudeBinary as defaultFindClaudeBinary } from './util/find-claude-binary';
import { stripAnsi } from './usage-runner/ansi';
import { parseUsageOutput, type UsageData } from './usage-runner/parser';
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
  hardTimeoutMs?: number;
  killGraceMs?: number;
}

const PARSER_LABEL_TO_RATE_LIMIT_TYPE: Record<UsageData['windows'][number]['label'], string> = {
  current_session: 'five_hour',
  week_all_models: 'seven_day',
  week_sonnet: 'seven_day_sonnet',
};

export function createUsageRunnerService(deps: UsageRunnerDeps): UsageRunnerService {
  const spawnPty = deps.spawnPty ?? defaultSpawnPty;
  const findBinary = deps.findClaudeBinary ?? (() => defaultFindClaudeBinary());
  const now = deps.now ?? Date.now;
  const settleQuietMs = deps.settleQuietMs ?? 750;
  const usageQuietMs = deps.usageQuietMs ?? 1500;
  const hardTimeoutMs = deps.hardTimeoutMs ?? 20000;
  const killGraceMs = deps.killGraceMs ?? 500;

  const inFlight = new Map<string, Promise<UsageRunResult>>();
  const cache = new Map<string, UsageRunResult>();

  function logWarn(msg: string, ctx?: Record<string, unknown>): void {
    if (!deps.logging) return;
    try {
      deps.logging.writeBatch([
        {
          timestamp: new Date().toISOString(),
          level: 'warn',
          source: 'usage-runner',
          message: msg,
          metadata: ctx ? JSON.stringify(ctx) : undefined,
        },
      ]);
    } catch {
      // never let logging failures escape
    }
  }

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

    // Phase 1: wait for TUI to settle
    while (Date.now() < hardDeadline) {
      if (Date.now() - lastByteAt >= settleQuietMs && buffer.length > 0) break;
      if (exited) break;
      await sleep(20);
    }
    if (exited || Date.now() >= hardDeadline) {
      try { pty.kill(); } catch { /* already gone */ }
      return cacheAndReturn(accountName, {
        ok: false, observed_at: observedAt, error: 'pty exited or timed out before /usage',
        raw: stripAnsi(buffer),
      });
    }

    // Phase 2: send /usage
    const beforeUsage = buffer.length;
    pty.write('/usage\r');

    // Phase 3: wait for /usage rendering to settle
    let lastSeenLen = beforeUsage;
    let stableSince = Date.now();
    while (Date.now() < hardDeadline) {
      if (buffer.length !== lastSeenLen) {
        lastSeenLen = buffer.length;
        stableSince = Date.now();
      } else if (buffer.length > beforeUsage && Date.now() - stableSince >= usageQuietMs) {
        break;
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
    // Dual-write to rate-limits
    for (const w of parsed.data.windows) {
      const type = PARSER_LABEL_TO_RATE_LIMIT_TYPE[w.label];
      deps.rateLimits.recordUtilization(configDir, type, w.pct_used, null);
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

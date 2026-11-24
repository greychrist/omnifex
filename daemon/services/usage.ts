import fs from 'node:fs';
import path from 'node:path';
import type { AccountsService } from './accounts';
import type { LoggingService } from './logging';
import { isRequestReplayLine } from './util/request-replay';
import { computeMessageCost } from '../../src/lib/pricing';

function logWarn(
  logging: LoggingService | null | undefined,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  if (!logging) return;
  try {
    logging.writeBatch([
      {
        timestamp: new Date().toISOString(),
        level: 'warn',
        source: 'usage',
        message,
        metadata: metadata ? JSON.stringify(metadata) : undefined,
      },
    ]);
  } catch {
    // Never let logging failures escape the usage scan.
  }
}

function logInfo(
  logging: LoggingService | null | undefined,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  if (!logging) return;
  try {
    logging.writeBatch([
      {
        timestamp: new Date().toISOString(),
        level: 'info',
        source: 'usage',
        message,
        metadata: metadata ? JSON.stringify(metadata) : undefined,
      },
    ]);
  } catch {
    // Never let logging failures escape the usage scan.
  }
}

function errString(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export interface UsageStats {
  total_cost: number;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  total_sessions: number;
  by_model: ModelUsage[];
  by_date: DailyUsage[];
  by_project: ProjectUsage[];
}

export interface ModelUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
}

export interface DailyUsage {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
}

export interface ProjectUsage {
  project_path: string;
  total_tokens: number;
  total_cost: number;
  session_count: number;
}

export interface UsageEntry {
  session_id: string;
  project_path: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  timestamp: string;
}

export interface AccountUsageStats {
  account_name: string;
  account_type: string;
  stats: UsageStats;
}

export interface UsageService {
  getUsageStats(): UsageStats;
  getUsageByDateRange(startDate: string, endDate: string): UsageStats;
  getSessionStats(since?: string, until?: string, order?: string): ProjectUsage[];
  getUsageDetails(limit?: number): UsageEntry[];
  getStatsByAccount(startDate?: string, endDate?: string): AccountUsageStats[];
}

interface RawMessage {
  type: string;
  requestId?: string;
  message?: {
    id?: string;
    role?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
    model?: string;
  };
  timestamp?: string;
  cwd?: string;
}

interface ParsedUsage {
  session_id: string;
  project_path: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost: number;
  timestamp: string;
  date: string;
  account_name: string;
  account_type: string;
}

// The dir-name encoding is lossy (`pi-tuitive-fe` vs `pi/tuitive/fe`): prefer `cwd`, the naive swap only as a fallback.

function decodeProjectPathNaive(dirName: string): string {
  return dirName.replace(/-/g, '/');
}

function recoverProjectPathFromMessages(messages: RawMessage[]): string | null {
  const cap = Math.min(messages.length, 50);
  for (let i = 0; i < cap; i++) {
    const cwd = messages[i]?.cwd;
    if (typeof cwd === 'string' && cwd.startsWith('/')) {
      return cwd;
    }
  }
  return null;
}

function parseJsonlLine(line: string): RawMessage | null {
  const trimmed = line.trim();
  if (!trimmed || isRequestReplayLine(trimmed)) return null;
  try {
    return JSON.parse(trimmed) as RawMessage;
  } catch {
    return null;
  }
}

function readJsonlFile(
  filePath: string,
  logging?: LoggingService | null,
): RawMessage[] {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content
      .split('\n')
      .map(parseJsonlLine)
      .filter((msg): msg is RawMessage => msg !== null);
  } catch (err) {
    logWarn(logging, `usage: failed to read session JSONL at ${filePath}`, {
      filePath,
      error: errString(err),
    });
    return [];
  }
}

/** project_path is not cached: it is recovered per scan so a project rename shows at once. */
type UsageRow = Omit<ParsedUsage, 'project_path'>;
interface SessionCacheEntry {
  mtimeMs: number;
  rows: UsageRow[];
  cwd: string | null;
}
export type UsageScanCache = Map<string, SessionCacheEntry>;

function extractUsageRows(
  messages: RawMessage[],
  sessionId: string,
  accountName: string,
  accountType: string,
): UsageRow[] {
  // The CLI writes one line per content block with identical usage; summing raw lines double-counts.
  const byKey = new Map<string, UsageRow>();
  let idx = 0;
  for (const msg of messages) {
    idx += 1;
    if (msg.type !== 'assistant') continue;
    if (!msg.message?.usage) continue;

    const usage = msg.message.usage;
    const model = msg.message.model ?? 'unknown';
    const key = msg.requestId ?? msg.message.id ?? `line:${idx}`;

    const timestamp = msg.timestamp ?? '';
    const date = timestamp ? timestamp.substring(0, 10) : '';
    // Price at the message's own day, not today's rates.
    const { usd } = computeMessageCost(model, usage, undefined, date || undefined);

    if (byKey.has(key)) byKey.delete(key);
    byKey.set(key, {
      session_id: sessionId,
      model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cost: usd,
      timestamp,
      date,
      account_name: accountName,
      account_type: accountType,
    });
  }
  return [...byKey.values()];
}

function scanConfigDir(
  configDir: string,
  accountName: string,
  accountType: string,
  filter?: (timestamp: string) => boolean,
  logging?: LoggingService | null,
  cache?: UsageScanCache,
): ParsedUsage[] {
  const results: ParsedUsage[] = [];
  const projectsDir = path.join(configDir, 'projects');

  let projectEntries: fs.Dirent[];
  try {
    projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (err) {
    logWarn(logging, `usage: failed to scan projects dir ${projectsDir}`, {
      configDir,
      accountName,
      error: errString(err),
    });
    return results;
  }

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;

    const projectDirName = projectEntry.name;
    const projectDir = path.join(projectsDir, projectDirName);

    let sessionFiles: fs.Dirent[];
    try {
      sessionFiles = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch (err) {
      logWarn(logging, `usage: failed to scan project session dir ${projectDir}`, {
        projectDir,
        accountName,
        error: errString(err),
      });
      continue;
    }

    // Newest first so the latest `cwd` wins: a renamed project's old JSONLs carry the old cwd.
    const orderedJsonl: { name: string; mtimeMs: number }[] = [];
    for (const sessionEntry of sessionFiles) {
      if (!sessionEntry.isFile() || !sessionEntry.name.endsWith('.jsonl')) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(path.join(projectDir, sessionEntry.name)).mtimeMs;
      } catch {
        // Stat failure → treat as oldest so a readable file still wins.
      }
      orderedJsonl.push({ name: sessionEntry.name, mtimeMs });
    }
    orderedJsonl.sort((a, b) => b.mtimeMs - a.mtimeMs);

    let recoveredProjectPath: string | null = null;

    for (const { name: sessionEntryName, mtimeMs } of orderedJsonl) {
      const sessionFile = path.join(projectDir, sessionEntryName);
      const sessionId = path.basename(sessionEntryName, '.jsonl');

      let entry = cache?.get(sessionFile);
      if (entry?.mtimeMs !== mtimeMs) {
        const messages = readJsonlFile(sessionFile, logging);
        entry = {
          mtimeMs,
          rows: extractUsageRows(messages, sessionId, accountName, accountType),
          cwd: recoverProjectPathFromMessages(messages),
        };
        cache?.set(sessionFile, entry);
      }

      if (recoveredProjectPath === null) {
        recoveredProjectPath = entry.cwd;
      }
      const projectPath = recoveredProjectPath ?? decodeProjectPathNaive(projectDirName);

      for (const row of entry.rows) {
        if (filter && !filter(row.timestamp)) continue;
        results.push({ ...row, project_path: projectPath });
      }
    }
  }

  return results;
}

function emptyStats(): UsageStats {
  return {
    total_cost: 0,
    total_tokens: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_creation_tokens: 0,
    total_cache_read_tokens: 0,
    total_sessions: 0,
    by_model: [],
    by_date: [],
    by_project: [],
  };
}

function aggregateEntries(entries: ParsedUsage[]): UsageStats {
  if (entries.length === 0) return emptyStats();

  const stats = emptyStats();

  const byModel = new Map<string, ModelUsage>();
  const byDate = new Map<string, DailyUsage>();
  const sessionsByProject = new Map<string, Set<string>>();
  const byProject = new Map<string, ProjectUsage>();

  for (const entry of entries) {
    stats.total_input_tokens += entry.input_tokens;
    stats.total_output_tokens += entry.output_tokens;
    stats.total_cache_creation_tokens += entry.cache_creation_tokens;
    stats.total_cache_read_tokens += entry.cache_read_tokens;
    stats.total_tokens += entry.input_tokens + entry.output_tokens;
    stats.total_cost += entry.cost;

    const modelEntry = byModel.get(entry.model) ?? {
      model: entry.model,
      input_tokens: 0,
      output_tokens: 0,
      cost: 0,
    };
    modelEntry.input_tokens += entry.input_tokens;
    modelEntry.output_tokens += entry.output_tokens;
    modelEntry.cost += entry.cost;
    byModel.set(entry.model, modelEntry);

    if (entry.date) {
      const dateEntry = byDate.get(entry.date) ?? {
        date: entry.date,
        input_tokens: 0,
        output_tokens: 0,
        cost: 0,
      };
      dateEntry.input_tokens += entry.input_tokens;
      dateEntry.output_tokens += entry.output_tokens;
      dateEntry.cost += entry.cost;
      byDate.set(entry.date, dateEntry);
    }

    const projEntry = byProject.get(entry.project_path) ?? {
      project_path: entry.project_path,
      total_tokens: 0,
      total_cost: 0,
      session_count: 0,
    };
    projEntry.total_tokens += entry.input_tokens + entry.output_tokens;
    projEntry.total_cost += entry.cost;
    byProject.set(entry.project_path, projEntry);

    const sessions = sessionsByProject.get(entry.project_path) ?? new Set<string>();
    sessions.add(entry.session_id);
    sessionsByProject.set(entry.project_path, sessions);
  }

  let totalSessions = 0;
  for (const [projectPath, sessionSet] of sessionsByProject) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- projectPath came from sessionsByProject keys; byProject mirrors them.
    const projEntry = byProject.get(projectPath)!;
    projEntry.session_count = sessionSet.size;
    totalSessions += sessionSet.size;
  }
  stats.total_sessions = totalSessions;

  stats.by_model = Array.from(byModel.values());
  stats.by_date = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  stats.by_project = Array.from(byProject.values());

  return stats;
}

function makeDateRangeFilter(startDate: string, endDate: string): (timestamp: string) => boolean {
  return (timestamp: string) => {
    const date = timestamp.substring(0, 10);
    return date >= startDate && date <= endDate;
  };
}

function makeSinceFilter(since: string): (timestamp: string) => boolean {
  return (timestamp: string) => {
    const date = timestamp.substring(0, 10);
    return date >= since;
  };
}

function makeUntilFilter(until: string): (timestamp: string) => boolean {
  return (timestamp: string) => {
    const date = timestamp.substring(0, 10);
    return date <= until;
  };
}

export function createUsageService(
  accounts: AccountsService,
  logging?: LoggingService | null,
): UsageService {
  const scanCache: UsageScanCache = new Map();

  function collectEntries(filter?: (timestamp: string) => boolean): ParsedUsage[] {
    const all: ParsedUsage[] = [];
    for (const account of accounts.listAccounts()) {
      const entries = scanConfigDir(
        account.config_dir,
        account.name,
        account.subscription_label,
        filter,
        logging,
        scanCache,
      );
      // Never log `entries`: a large blob into app_logs on every query.
      logInfo(logging, `usage scrape: account "${account.name}" — ${entries.length} entries`, {
        account_name: account.name,
        config_dir: account.config_dir,
        entry_count: entries.length,
      });
      all.push(...entries);
    }
    return all;
  }

  function getUsageStats(): UsageStats {
    return aggregateEntries(collectEntries());
  }

  function getUsageByDateRange(startDate: string, endDate: string): UsageStats {
    const filter = makeDateRangeFilter(startDate, endDate);
    return aggregateEntries(collectEntries(filter));
  }

  function getSessionStats(since?: string, until?: string, _order?: string): ProjectUsage[] {
    let filter: ((timestamp: string) => boolean) | undefined;

    if (since && until) {
      filter = makeDateRangeFilter(since, until);
    } else if (since) {
      filter = makeSinceFilter(since);
    } else if (until) {
      filter = makeUntilFilter(until);
    }

    const entries = collectEntries(filter);
    const stats = aggregateEntries(entries);
    return stats.by_project;
  }

  function getUsageDetails(limit?: number): UsageEntry[] {
    const entries = collectEntries();
    const usageEntries: UsageEntry[] = entries.map((e) => ({
      session_id: e.session_id,
      project_path: e.project_path,
      model: e.model,
      input_tokens: e.input_tokens,
      output_tokens: e.output_tokens,
      cost: e.cost,
      timestamp: e.timestamp,
    }));

    if (limit !== undefined && limit >= 0) {
      return usageEntries.slice(0, limit);
    }

    return usageEntries;
  }

  function getStatsByAccount(startDate?: string, endDate?: string): AccountUsageStats[] {
    let filter: ((timestamp: string) => boolean) | undefined;
    if (startDate && endDate) {
      filter = makeDateRangeFilter(startDate, endDate);
    }

    const entries = collectEntries(filter);

    const byAccount = new Map<string, { account_type: string; entries: ParsedUsage[] }>();
    for (const entry of entries) {
      const existing = byAccount.get(entry.account_name);
      if (existing) {
        existing.entries.push(entry);
      } else {
        byAccount.set(entry.account_name, {
          account_type: entry.account_type,
          entries: [entry],
        });
      }
    }

    const results: AccountUsageStats[] = [];
    for (const [accountName, { account_type, entries: accountEntries }] of byAccount) {
      results.push({
        account_name: accountName,
        account_type: account_type,
        stats: aggregateEntries(accountEntries),
      });
    }

    return results;
  }

  return {
    getUsageStats,
    getUsageByDateRange,
    getSessionStats,
    getUsageDetails,
    getStatsByAccount,
  };
}

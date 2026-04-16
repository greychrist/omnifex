import fs from 'node:fs';
import path from 'node:path';
import type { AccountsService } from './accounts';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawMessage {
  type: string;
  message?: {
    role?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    model?: string;
  };
  timestamp?: string;
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

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------

function getCostPerToken(model: string): { input: number; output: number } {
  if (model.includes('opus')) return { input: 15 / 1_000_000, output: 75 / 1_000_000 };
  if (model.includes('sonnet')) return { input: 3 / 1_000_000, output: 15 / 1_000_000 };
  if (model.includes('haiku')) return { input: 0.25 / 1_000_000, output: 1.25 / 1_000_000 };
  return { input: 3 / 1_000_000, output: 15 / 1_000_000 }; // default to sonnet
}

// ---------------------------------------------------------------------------
// Project path decoding
// Converts a directory name like '-Users-greg-myproject' → '/Users/greg/myproject'
// ---------------------------------------------------------------------------

function decodeProjectPath(dirName: string): string {
  // dirName starts with '-', e.g. '-Users-greg-myproject'
  // Replace all '-' with '/' to get '/Users/greg/myproject'
  return dirName.replace(/-/g, '/');
}

// ---------------------------------------------------------------------------
// JSONL parsing helpers
// ---------------------------------------------------------------------------

function parseJsonlLine(line: string): RawMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as RawMessage;
  } catch {
    return null;
  }
}

function readJsonlFile(filePath: string): RawMessage[] {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content
      .split('\n')
      .map(parseJsonlLine)
      .filter((msg): msg is RawMessage => msg !== null);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Core scanning logic
// ---------------------------------------------------------------------------

function scanConfigDir(
  configDir: string,
  accountName: string,
  accountType: string,
  filter?: (timestamp: string) => boolean,
): ParsedUsage[] {
  const results: ParsedUsage[] = [];
  const projectsDir = path.join(configDir, 'projects');

  let projectEntries: fs.Dirent[];
  try {
    projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;

    const projectDirName = projectEntry.name;
    const projectPath = decodeProjectPath(projectDirName);
    const projectDir = path.join(projectsDir, projectDirName);

    let sessionFiles: fs.Dirent[];
    try {
      sessionFiles = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sessionEntry of sessionFiles) {
      if (!sessionEntry.isFile() || !sessionEntry.name.endsWith('.jsonl')) continue;

      const sessionFile = path.join(projectDir, sessionEntry.name);
      const sessionId = path.basename(sessionEntry.name, '.jsonl');
      const messages = readJsonlFile(sessionFile);

      for (const msg of messages) {
        if (msg.type !== 'assistant') continue;
        if (!msg.message?.usage) continue;

        const timestamp = msg.timestamp ?? '';
        if (filter && !filter(timestamp)) continue;

        const usage = msg.message.usage;
        const model = msg.message.model ?? 'unknown';
        const inputTokens = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;
        const cacheCreation = usage.cache_creation_input_tokens ?? 0;
        const cacheRead = usage.cache_read_input_tokens ?? 0;

        const rates = getCostPerToken(model);
        const cost = inputTokens * rates.input + outputTokens * rates.output;

        const date = timestamp ? timestamp.substring(0, 10) : '';

        results.push({
          session_id: sessionId,
          project_path: projectPath,
          model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_tokens: cacheCreation,
          cache_read_tokens: cacheRead,
          cost,
          timestamp,
          date,
          account_name: accountName,
          account_type: accountType,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

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

  // Accumulators
  const byModel = new Map<string, ModelUsage>();
  const byDate = new Map<string, DailyUsage>();
  // Track unique sessions per project: projectPath → Set<sessionId>
  const sessionsByProject = new Map<string, Set<string>>();
  const byProject = new Map<string, ProjectUsage>();

  for (const entry of entries) {
    stats.total_input_tokens += entry.input_tokens;
    stats.total_output_tokens += entry.output_tokens;
    stats.total_cache_creation_tokens += entry.cache_creation_tokens;
    stats.total_cache_read_tokens += entry.cache_read_tokens;
    stats.total_tokens += entry.input_tokens + entry.output_tokens;
    stats.total_cost += entry.cost;

    // By model
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

    // By date
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

    // By project
    const projEntry = byProject.get(entry.project_path) ?? {
      project_path: entry.project_path,
      total_tokens: 0,
      total_cost: 0,
      session_count: 0,
    };
    projEntry.total_tokens += entry.input_tokens + entry.output_tokens;
    projEntry.total_cost += entry.cost;
    byProject.set(entry.project_path, projEntry);

    // Track unique sessions per project
    const sessions = sessionsByProject.get(entry.project_path) ?? new Set<string>();
    sessions.add(entry.session_id);
    sessionsByProject.set(entry.project_path, sessions);
  }

  // Resolve session counts and total_sessions
  let totalSessions = 0;
  for (const [projectPath, sessionSet] of sessionsByProject) {
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

// ---------------------------------------------------------------------------
// Date range filter helpers
// ---------------------------------------------------------------------------

function makeDateRangeFilter(startDate: string, endDate: string): (timestamp: string) => boolean {
  // startDate and endDate are 'YYYY-MM-DD' strings
  // timestamp is ISO string like '2026-04-09T12:00:00Z'
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createUsageService(accounts: AccountsService): UsageService {
  function collectEntries(filter?: (timestamp: string) => boolean): ParsedUsage[] {
    const all: ParsedUsage[] = [];
    for (const account of accounts.listAccounts()) {
      const entries = scanConfigDir(account.config_dir, account.name, account.account_type, filter);
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

    const accountList = accounts.listAccounts();
    console.log(`[usage] getStatsByAccount: ${accountList.length} accounts, dateRange=${startDate ?? 'none'}..${endDate ?? 'none'}`);
    for (const a of accountList) {
      console.log(`[usage]   account "${a.name}" config_dir=${a.config_dir}`);
    }

    const entries = collectEntries(filter);
    console.log(`[usage] getStatsByAccount: ${entries.length} total entries collected`);

    // Group entries by account name
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

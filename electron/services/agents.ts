import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import crypto from 'node:crypto';
import type { Database } from './database';
import type { AccountsService } from './accounts';
import type { ClaudeBinaryService } from './claude-binary';
import type { ProcessRegistry } from './process-registry';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface Agent {
  id: number;
  name: string;
  icon: string;
  system_prompt: string;
  default_task: string | null;
  model: string;
  hooks: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRun {
  id: number;
  agent_id: number;
  agent_name: string;
  agent_icon: string;
  task: string;
  model: string;
  project_path: string;
  session_id: string;
  status: string;
  pid: number | null;
  process_started_at: string | null;
  created_at: string;
  completed_at: string | null;
  account_id?: number;
  account_name?: string;
}

export interface AgentRunWithMetrics extends AgentRun {
  // Additional metrics can be added as needed
}

export interface AgentsService {
  // CRUD
  listAgents(): Agent[];
  createAgent(params: {
    name: string;
    icon: string;
    system_prompt: string;
    default_task?: string | null;
    model?: string;
    hooks?: string | null;
  }): Agent;
  updateAgent(params: {
    id: number;
    name: string;
    icon: string;
    system_prompt: string;
    default_task?: string | null;
    model?: string;
    hooks?: string | null;
  }): void;
  deleteAgent(id: number): void;
  getAgent(id: number): Agent | null;
  exportAgent(id: number): string;
  importAgent(jsonData: string): Agent;

  // Execution
  executeAgent(params: {
    agentId: number;
    projectPath: string;
    task: string;
    model?: string;
  }): Promise<number>;

  // Runs
  listAgentRuns(agentId?: number): AgentRun[];
  getAgentRun(id: number): AgentRun | null;
  getAgentRunWithRealTimeMetrics(id: number): AgentRun | null;
  killAgentSession(runId: number): void;
  getSessionStatus(runId: number): string;
  cleanupFinishedProcesses(): number[];
  getSessionOutput(runId: number): string;
  getLiveSessionOutput(runId: number): string;
  streamSessionOutput(runId: number): void;

  // GitHub
  fetchGitHubAgents(): Promise<GitHubFile[]>;
  fetchGitHubAgentContent(downloadUrl: string): Promise<string>;
  importAgentFromGitHub(downloadUrl: string): Promise<Agent>;
}

export interface GitHubFile {
  name: string;
  path: string;
  download_url: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Row types from SQLite
// ---------------------------------------------------------------------------

interface AgentRow {
  id: number;
  name: string;
  icon: string;
  system_prompt: string;
  default_task: string | null;
  model: string;
  hooks: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentRunRow {
  id: number;
  agent_id: number;
  agent_name: string;
  agent_icon: string;
  task: string;
  model: string;
  project_path: string;
  session_id: string;
  status: string;
  pid: number | null;
  process_started_at: string | null;
  created_at: string;
  completed_at: string | null;
}

// GitHub community agents repo
const GITHUB_AGENTS_REPO = 'anthropics/claude-code-agents';
const GITHUB_AGENTS_PATH = 'agents';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentsService(
  db: Database,
  accounts: AccountsService,
  claudeBinary: ClaudeBinaryService,
  processRegistry: ProcessRegistry,
  sendToRenderer: (channel: string, ...args: unknown[]) => void,
): AgentsService {
  const raw = db.raw;

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  function listAgents(): Agent[] {
    return raw
      .prepare('SELECT * FROM agents ORDER BY updated_at DESC')
      .all() as Agent[];
  }

  function createAgent(params: {
    name: string;
    icon: string;
    system_prompt: string;
    default_task?: string | null;
    model?: string;
    hooks?: string | null;
  }): Agent {
    const model = params.model ?? 'sonnet';
    const info = raw
      .prepare(
        `INSERT INTO agents (name, icon, system_prompt, default_task, model, hooks)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.name,
        params.icon,
        params.system_prompt,
        params.default_task ?? null,
        model,
        params.hooks ?? null,
      );

    const row = raw
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get(info.lastInsertRowid) as AgentRow;

    return row;
  }

  function updateAgent(params: {
    id: number;
    name: string;
    icon: string;
    system_prompt: string;
    default_task?: string | null;
    model?: string;
    hooks?: string | null;
  }): void {
    raw
      .prepare(
        `UPDATE agents
         SET name = ?, icon = ?, system_prompt = ?, default_task = ?, model = ?, hooks = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(
        params.name,
        params.icon,
        params.system_prompt,
        params.default_task ?? null,
        params.model ?? 'sonnet',
        params.hooks ?? null,
        params.id,
      );
  }

  function deleteAgent(id: number): void {
    raw.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  function getAgent(id: number): Agent | null {
    const row = raw
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get(id) as AgentRow | undefined;
    return row ?? null;
  }

  function exportAgent(id: number): string {
    const agent = getAgent(id);
    if (!agent) throw new Error(`Agent ${id} not found`);
    return JSON.stringify(agent, null, 2);
  }

  function importAgent(jsonData: string): Agent {
    const data = JSON.parse(jsonData) as Partial<Agent>;
    return createAgent({
      name: data.name ?? 'Imported Agent',
      icon: data.icon ?? '🤖',
      system_prompt: data.system_prompt ?? '',
      default_task: data.default_task ?? null,
      model: data.model ?? 'sonnet',
      hooks: data.hooks ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  async function executeAgent(params: {
    agentId: number;
    projectPath: string;
    task: string;
    model?: string;
  }): Promise<number> {
    const agent = getAgent(params.agentId);
    if (!agent) throw new Error(`Agent ${params.agentId} not found`);

    const account = accounts.resolve(params.projectPath);
    if (!account) throw new Error(`No account resolved for path: ${params.projectPath}`);

    const binaryPath = claudeBinary.findBestBinary();
    if (!binaryPath) throw new Error('No Claude binary found');

    const sessionId = crypto.randomUUID();
    const model = params.model ?? agent.model;

    // Insert run record
    const info = raw
      .prepare(
        `INSERT INTO agent_runs
         (agent_id, agent_name, agent_icon, task, model, project_path, session_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(
        agent.id,
        agent.name,
        agent.icon,
        params.task,
        model,
        params.projectPath,
        sessionId,
      );

    const runId = info.lastInsertRowid as number;

    // Spawn the process
    const args = [
      '--system-prompt', agent.system_prompt,
      '--model', model,
      '--output-format', 'stream-json',
      '-p', params.task,
    ];

    const proc = spawn(binaryPath, args, {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: account.config_dir,
      },
      cwd: params.projectPath,
    });

    // Update PID
    if (proc.pid) {
      raw
        .prepare(
          `UPDATE agent_runs SET pid = ?, process_started_at = CURRENT_TIMESTAMP WHERE id = ?`,
        )
        .run(proc.pid, runId);
    }

    // Register in process registry
    processRegistry.register(runId, proc);

    // Stream stdout line-by-line
    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        sendToRenderer(`claude-output:${runId}`, line);
      });
    }

    // On exit, update status
    proc.on('close', (code) => {
      const status = code === 0 ? 'completed' : 'failed';
      raw
        .prepare(
          `UPDATE agent_runs SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
        )
        .run(status, runId);
      processRegistry.remove(runId);
    });

    return runId;
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  function listAgentRuns(agentId?: number): AgentRun[] {
    if (agentId !== undefined) {
      return raw
        .prepare(
          'SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY created_at DESC',
        )
        .all(agentId) as AgentRunRow[];
    }
    return raw
      .prepare('SELECT * FROM agent_runs ORDER BY created_at DESC')
      .all() as AgentRunRow[];
  }

  function getAgentRun(id: number): AgentRun | null {
    const row = raw
      .prepare('SELECT * FROM agent_runs WHERE id = ?')
      .get(id) as AgentRunRow | undefined;
    return row ?? null;
  }

  function getAgentRunWithRealTimeMetrics(id: number): AgentRun | null {
    return getAgentRun(id);
  }

  function killAgentSession(runId: number): void {
    processRegistry.kill(runId);
    raw
      .prepare(
        `UPDATE agent_runs SET status = 'killed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(runId);
  }

  function getSessionStatus(runId: number): string {
    const proc = processRegistry.get(runId);
    if (proc) {
      if (proc.killed) return 'killed';
      if (proc.exitCode !== null) return proc.exitCode === 0 ? 'completed' : 'failed';
      return 'running';
    }
    // Check the database
    const run = getAgentRun(runId);
    return run?.status ?? 'unknown';
  }

  function cleanupFinishedProcesses(): number[] {
    const cleaned = processRegistry.cleanup();
    // Update status for all cleaned runs
    for (const runId of cleaned) {
      const run = getAgentRun(runId);
      if (run && run.status === 'running') {
        raw
          .prepare(
            `UPDATE agent_runs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
          )
          .run(runId);
      }
    }
    return cleaned;
  }

  function getSessionOutput(_runId: number): string {
    // Output is streamed via events; no file-based output in this implementation
    return '';
  }

  function getLiveSessionOutput(runId: number): string {
    return getSessionOutput(runId);
  }

  function streamSessionOutput(_runId: number): void {
    // No-op: handled via claude-output:<runId> events
  }

  // -------------------------------------------------------------------------
  // GitHub
  // -------------------------------------------------------------------------

  async function fetchGitHubAgents(): Promise<GitHubFile[]> {
    const url = `https://api.github.com/repos/${GITHUB_AGENTS_REPO}/contents/${GITHUB_AGENTS_PATH}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<GitHubFile[]>;
  }

  async function fetchGitHubAgentContent(downloadUrl: string): Promise<string> {
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch agent content: ${res.status} ${res.statusText}`);
    }
    return res.text();
  }

  async function importAgentFromGitHub(downloadUrl: string): Promise<Agent> {
    const content = await fetchGitHubAgentContent(downloadUrl);
    return importAgent(content);
  }

  // -------------------------------------------------------------------------
  // Return service object
  // -------------------------------------------------------------------------

  return {
    listAgents,
    createAgent,
    updateAgent,
    deleteAgent,
    getAgent,
    exportAgent,
    importAgent,
    executeAgent,
    listAgentRuns,
    getAgentRun,
    getAgentRunWithRealTimeMetrics,
    killAgentSession,
    getSessionStatus,
    cleanupFinishedProcesses,
    getSessionOutput,
    getLiveSessionOutput,
    streamSessionOutput,
    fetchGitHubAgents,
    fetchGitHubAgentContent,
    importAgentFromGitHub,
  };
}

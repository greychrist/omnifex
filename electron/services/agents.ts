import crypto from 'node:crypto';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Database } from './database';
import type { AccountsService } from './accounts';
import type { ClaudeBinaryService } from './claude-binary';
import type { AgentRunRegistry } from './agent-run-registry';

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
  agentRunRegistry: AgentRunRegistry,
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

    // The claude binary path is no longer required — the SDK finds it itself.
    // We still call findBestBinary() as a soft probe (the result goes into
    // pathToClaudeCodeExecutable if present so we can pin a specific binary
    // when the user has multiple installs, e.g. Greg's dual-account setup).
    const binaryPath = claudeBinary.findBestBinary();

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

    // Build SDK options — mirror the interactive-session path in
    // electron/services/sessions.ts so agent runs and interactive sessions
    // behave consistently. CLAUDE_CONFIG_DIR pins the session to the
    // resolved account; settingSources loads CLAUDE.md + skills + commands;
    // strictMcpConfig surfaces bad MCP configs instead of swallowing them.
    //
    // permissionMode defaults to 'acceptEdits' — the same default as
    // interactive sessions (ClaudeCodeSession useState). This is critical
    // for agents specifically: without a permissionMode override AND
    // without a canUseTool callback, the SDK would default to 'default'
    // (Ask every time), which would hang the agent run forever waiting
    // for prompts that have nowhere to surface. acceptEdits auto-approves
    // Read/Write/Edit so the agent can actually make progress on its task
    // without surprising the user with destructive-op auto-approval —
    // that's what bypassPermissions is for, and we deliberately do NOT
    // want that as the default.
    const options: Record<string, unknown> = {
      systemPrompt: agent.system_prompt,
      model,
      permissionMode: 'acceptEdits',
      cwd: params.projectPath,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: account.config_dir,
      },
      settingSources: ['user', 'project', 'local'],
      strictMcpConfig: true,
    };
    if (binaryPath) {
      options.pathToClaudeCodeExecutable = binaryPath;
    }

    // Mark process start timestamp (pid column stays NULL — the SDK doesn't
    // give us a PID directly, and we use the Query handle for kill/interrupt
    // instead).
    raw
      .prepare(
        `UPDATE agent_runs SET process_started_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(runId);

    // Kick off the SDK query. One-shot prompt (not a streaming channel) —
    // agents run to completion on a single task.
    const q = sdkQuery({
      prompt: params.task,
      options: options as any,
    });

    // Register in the agent-run registry with running status. killAgentSession
    // will flip status → 'killed' and call q.close().
    agentRunRegistry.register(runId, { query: q, status: 'running' });

    // Start the async listener. Fire-and-forget; the listener updates status
    // + DB when the stream ends, either naturally or via throw.
    void listenToAgentStream(runId, q);

    return runId;
  }

  async function listenToAgentStream(runId: number, q: any): Promise<void> {
    let finalStatus: 'completed' | 'failed' = 'completed';
    try {
      for await (const message of q) {
        const msg = message as any;

        // Skip the SDK's echo of our own task prompt. When query() is given
        // a string prompt, the SDK emits a type:'user' message at the top
        // of the stream to represent that initial turn — useful for the
        // interactive session UI where the user *did* type it, but wrong
        // for agent runs where the task came from the agent service, not
        // from the user. Without this filter the agent view shows the
        // task verbatim as if the user sent it.
        //
        // We still forward user messages with a non-null parent_tool_use_id
        // because those are tool results (SDK wraps tool results as user
        // messages attached to the parent tool_use).
        if (
          msg &&
          msg.type === 'user' &&
          (msg.parent_tool_use_id === null || msg.parent_tool_use_id === undefined)
        ) {
          continue;
        }

        // Forward every SDK message to the renderer as a JSON string so the
        // existing AgentExecution/SessionOutputViewer/AgentRunOutputViewer
        // parse path (JSON.parse(payload)) keeps working. Note the channel
        // name is agent-output:<runId> — the pre-migration code was sending
        // claude-output:<runId> which the renderers never listened to, so
        // agent output has been invisible until now.
        try {
          sendToRenderer(`agent-output:${runId}`, JSON.stringify(message));
        } catch (err) {
          console.error('[agents] failed to stringify SDK message:', err);
        }

        // Determine final status from the result message, same as sessions.ts.
        if (msg.type === 'result') {
          if (msg.is_error || msg.subtype === 'error') {
            finalStatus = 'failed';
          }
        }
      }
    } catch (err) {
      finalStatus = 'failed';
      const errMsg = err instanceof Error ? err.message : String(err);
      sendToRenderer(`agent-error:${runId}`, errMsg);
      console.error(`[agents] stream error for run ${runId}:`, err);
    }

    // Check if the run was killed — if so, preserve the killed status.
    const handle = agentRunRegistry.get(runId);
    if (handle && handle.status === 'killed') {
      // killAgentSession already updated the DB status; don't overwrite.
      sendToRenderer(`agent-complete:${runId}`);
      return;
    }

    agentRunRegistry.setStatus(runId, finalStatus);
    raw
      .prepare(
        `UPDATE agent_runs SET status = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(finalStatus, runId);
    sendToRenderer(`agent-complete:${runId}`);
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
    // kill() on the registry flips status → 'killed' and calls query.close().
    // It returns false if the run isn't registered, in which case we just
    // update the DB (the run might have already finished; this is idempotent).
    const wasRegistered = agentRunRegistry.kill(runId);
    raw
      .prepare(
        `UPDATE agent_runs SET status = 'killed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(runId);
    if (wasRegistered) {
      sendToRenderer(`agent-cancelled:${runId}`);
    }
  }

  function getSessionStatus(runId: number): string {
    const handle = agentRunRegistry.get(runId);
    if (handle) return handle.status;
    // Check the database
    const run = getAgentRun(runId);
    return run?.status ?? 'unknown';
  }

  function cleanupFinishedProcesses(): number[] {
    const cleaned = agentRunRegistry.cleanup();
    // Update status for all cleaned runs — match what the registry reported.
    // (The status should already be updated at this point for normal runs;
    // this is defensive for cases where cleanup races a status update.)
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

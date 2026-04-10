import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService, type AccountsService } from '../services/accounts';
import { createAgentsService, type AgentsService, type Agent } from '../services/agents';
import { createProcessRegistry, type ProcessRegistry } from '../services/process-registry';
import { spawn as rawSpawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

const mockedSpawn = vi.mocked(rawSpawn);

// ---------------------------------------------------------------------------
// Fake child process — minimal shape needed by executeAgent.
// We use a real PassThrough for stdout so `readline.createInterface` can read
// from it as if it were a real process stream.
// ---------------------------------------------------------------------------

interface FakeProcessHandle {
  proc: any;
  emitClose: (code: number | null) => void;
  pushLine: (line: string) => void;
  endStdout: () => void;
}

function createFakeProcess(opts: { pid?: number | null; noStdout?: boolean } = {}): FakeProcessHandle {
  const { pid = 9999, noStdout = false } = opts;
  const emitter = new EventEmitter();
  const stdout = noStdout ? null : new PassThrough();

  const fake: any = {
    pid,
    stdout,
    stdin: null,
    stderr: null,
    killed: false,
    exitCode: null,
    kill: vi.fn((_signal?: string) => {
      fake.killed = true;
      return true;
    }),
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
    off: emitter.off.bind(emitter),
  };

  return {
    proc: fake,
    emitClose: (code) => {
      fake.exitCode = code;
      emitter.emit('close', code);
    },
    pushLine: (line) => {
      if (!stdout) throw new Error('fake process has no stdout');
      stdout.write(line + '\n');
    },
    endStdout: () => {
      if (stdout) stdout.end();
    },
  };
}

/** Flush pending microtasks so stream data is delivered. */
async function flush(ticks = 3): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClaudeBinaryService(path: string | null = '/usr/local/bin/claude') {
  return {
    getPath: vi.fn().mockReturnValue(path),
    setPath: vi.fn(),
    listInstallations: vi.fn().mockReturnValue([]),
    findBestBinary: vi.fn().mockReturnValue(path),
  };
}

function makeSendToRenderer() {
  return vi.fn<(channel: string, ...args: unknown[]) => void>();
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('agents service — CRUD', () => {
  let db: Database;
  let accounts: AccountsService;
  let service: AgentsService;
  let processRegistry: ProcessRegistry;

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    processRegistry = createProcessRegistry();
    service = createAgentsService(
      db,
      accounts,
      makeClaudeBinaryService(),
      processRegistry,
      makeSendToRenderer(),
    );
  });

  afterEach(() => {
    db.close();
  });

  it('createAgent and listAgents', () => {
    service.createAgent({
      name: 'Test Agent',
      icon: '🤖',
      system_prompt: 'You are a helpful assistant.',
      model: 'sonnet',
    });

    const agents = service.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('Test Agent');
    expect(agents[0].icon).toBe('🤖');
    expect(agents[0].system_prompt).toBe('You are a helpful assistant.');
    expect(agents[0].model).toBe('sonnet');
  });

  it('getAgent by id', () => {
    const created = service.createAgent({
      name: 'Finder',
      icon: '🔍',
      system_prompt: 'Find things.',
    });

    const fetched = service.getAgent(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe('Finder');
  });

  it('getAgent returns null for unknown id', () => {
    expect(service.getAgent(9999)).toBeNull();
  });

  it('updateAgent', () => {
    const agent = service.createAgent({
      name: 'Original',
      icon: '📝',
      system_prompt: 'Original prompt.',
      model: 'sonnet',
    });

    service.updateAgent({
      id: agent.id,
      name: 'Updated',
      icon: '✏️',
      system_prompt: 'Updated prompt.',
      model: 'opus',
    });

    const updated = service.getAgent(agent.id);
    expect(updated!.name).toBe('Updated');
    expect(updated!.icon).toBe('✏️');
    expect(updated!.system_prompt).toBe('Updated prompt.');
    expect(updated!.model).toBe('opus');
  });

  it('deleteAgent', () => {
    const agent = service.createAgent({
      name: 'ToDelete',
      icon: '🗑️',
      system_prompt: 'Delete me.',
    });

    service.deleteAgent(agent.id);

    expect(service.getAgent(agent.id)).toBeNull();
    expect(service.listAgents()).toHaveLength(0);
  });

  it('exportAgent returns JSON string with agent data', () => {
    const agent = service.createAgent({
      name: 'Exportable',
      icon: '📤',
      system_prompt: 'Export me.',
      model: 'haiku',
    });

    const json = service.exportAgent(agent.id);
    const parsed = JSON.parse(json) as Agent;

    expect(parsed.name).toBe('Exportable');
    expect(parsed.icon).toBe('📤');
    expect(parsed.system_prompt).toBe('Export me.');
    expect(parsed.model).toBe('haiku');
  });

  it('exportAgent throws for unknown id', () => {
    expect(() => service.exportAgent(9999)).toThrow(/not found/i);
  });

  it('importAgent from JSON string creates a new agent', () => {
    const original = service.createAgent({
      name: 'Template',
      icon: '📋',
      system_prompt: 'Template prompt.',
      model: 'sonnet',
      hooks: null,
    });
    const json = service.exportAgent(original.id);

    // Remove the original so we can verify import creates new
    service.deleteAgent(original.id);
    expect(service.listAgents()).toHaveLength(0);

    const imported = service.importAgent(json);
    expect(imported.name).toBe('Template');
    expect(imported.icon).toBe('📋');
    expect(imported.system_prompt).toBe('Template prompt.');

    const all = service.listAgents();
    expect(all).toHaveLength(1);
  });

  it('importAgent uses defaults for missing fields', () => {
    const json = JSON.stringify({ system_prompt: 'Minimal.' });
    const imported = service.importAgent(json);

    expect(imported.name).toBe('Imported Agent');
    expect(imported.icon).toBe('🤖');
    expect(imported.model).toBe('sonnet');
  });

  it('listAgents returns agents ordered by updated_at DESC', () => {
    const a1 = service.createAgent({ name: 'First', icon: '1️⃣', system_prompt: 'A' });
    const a2 = service.createAgent({ name: 'Second', icon: '2️⃣', system_prompt: 'B' });

    const agents = service.listAgents();
    expect(agents).toHaveLength(2);
    const names = agents.map((a) => a.name);
    expect(names).toContain('First');
    expect(names).toContain('Second');

    // Bump updated_at on a1 so it clearly comes first in a future query
    service.updateAgent({ id: a1.id, name: 'First Updated', icon: '1️⃣', system_prompt: 'A' });
    const reordered = service.listAgents();
    expect(reordered[0].name).toBe('First Updated');
    expect(reordered[1].id).toBe(a2.id);
  });
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

describe('agents service — runs', () => {
  let db: Database;
  let accounts: AccountsService;
  let service: AgentsService;
  let processRegistry: ProcessRegistry;

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    processRegistry = createProcessRegistry();
    service = createAgentsService(
      db,
      accounts,
      makeClaudeBinaryService(),
      processRegistry,
      makeSendToRenderer(),
    );
  });

  afterEach(() => {
    db.close();
  });

  it('listAgentRuns returns empty initially', () => {
    const runs = service.listAgentRuns();
    expect(runs).toHaveLength(0);
  });

  it('getAgentRun returns inserted run record', () => {
    // Create agent first (for FK constraint)
    const agent = service.createAgent({
      name: 'Runner',
      icon: '🏃',
      system_prompt: 'Run things.',
    });

    // Insert a run directly into DB
    const info = db.raw
      .prepare(
        `INSERT INTO agent_runs
         (agent_id, agent_name, agent_icon, task, model, project_path, session_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id,
        agent.name,
        agent.icon,
        'Do a task',
        'sonnet',
        '/home/user/project',
        'test-session-001',
        'completed',
      );

    const runId = info.lastInsertRowid as number;
    const run = service.getAgentRun(runId);

    expect(run).not.toBeNull();
    expect(run!.id).toBe(runId);
    expect(run!.agent_id).toBe(agent.id);
    expect(run!.task).toBe('Do a task');
    expect(run!.status).toBe('completed');
    expect(run!.session_id).toBe('test-session-001');
  });

  it('getAgentRun returns null for unknown id', () => {
    expect(service.getAgentRun(9999)).toBeNull();
  });

  it('listAgentRuns filtered by agentId', () => {
    const agent1 = service.createAgent({ name: 'A1', icon: '1️⃣', system_prompt: 'A' });
    const agent2 = service.createAgent({ name: 'A2', icon: '2️⃣', system_prompt: 'B' });

    // Insert two runs for agent1, one for agent2
    for (let i = 0; i < 2; i++) {
      db.raw
        .prepare(
          `INSERT INTO agent_runs
           (agent_id, agent_name, agent_icon, task, model, project_path, session_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(agent1.id, agent1.name, agent1.icon, `Task ${i}`, 'sonnet', '/project', `session-${i}`, 'completed');
    }
    db.raw
      .prepare(
        `INSERT INTO agent_runs
         (agent_id, agent_name, agent_icon, task, model, project_path, session_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(agent2.id, agent2.name, agent2.icon, 'Task B', 'sonnet', '/project2', 'session-b', 'running');

    const runsForAgent1 = service.listAgentRuns(agent1.id);
    expect(runsForAgent1).toHaveLength(2);
    for (const r of runsForAgent1) {
      expect(r.agent_id).toBe(agent1.id);
    }

    const runsForAgent2 = service.listAgentRuns(agent2.id);
    expect(runsForAgent2).toHaveLength(1);
    expect(runsForAgent2[0].agent_id).toBe(agent2.id);

    // Unfiltered returns all
    const all = service.listAgentRuns();
    expect(all).toHaveLength(3);
  });

  it('getAgentRunWithRealTimeMetrics returns same as getAgentRun', () => {
    const agent = service.createAgent({ name: 'A', icon: '🤖', system_prompt: 'P' });
    const info = db.raw
      .prepare(
        `INSERT INTO agent_runs
         (agent_id, agent_name, agent_icon, task, model, project_path, session_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(agent.id, agent.name, agent.icon, 'T', 'sonnet', '/p', 'sid', 'running');
    const runId = info.lastInsertRowid as number;

    const withMetrics = service.getAgentRunWithRealTimeMetrics(runId);
    const plain = service.getAgentRun(runId);
    expect(withMetrics).toEqual(plain);
  });
});

// ---------------------------------------------------------------------------
// Process registry
// ---------------------------------------------------------------------------

describe('process registry', () => {
  it('registers and retrieves a process', () => {
    const registry = createProcessRegistry();
    const mockProc = { kill: vi.fn(), exitCode: null, killed: false } as any;

    registry.register(1, mockProc);
    expect(registry.get(1)).toBe(mockProc);
  });

  it('returns undefined for unregistered run id', () => {
    const registry = createProcessRegistry();
    expect(registry.get(999)).toBeUndefined();
  });

  it('kill sends SIGTERM and removes from registry', () => {
    const registry = createProcessRegistry();
    const mockProc = { kill: vi.fn(), exitCode: null, killed: false } as any;
    registry.register(42, mockProc);

    const result = registry.kill(42);
    expect(result).toBe(true);
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(registry.get(42)).toBeUndefined();
  });

  it('kill returns false for unknown run id', () => {
    const registry = createProcessRegistry();
    expect(registry.kill(999)).toBe(false);
  });

  it('remove deletes from registry', () => {
    const registry = createProcessRegistry();
    const mockProc = { kill: vi.fn(), exitCode: null, killed: false } as any;
    registry.register(7, mockProc);
    registry.remove(7);
    expect(registry.get(7)).toBeUndefined();
  });

  it('getAll returns all registered processes', () => {
    const registry = createProcessRegistry();
    const p1 = { kill: vi.fn(), exitCode: null, killed: false } as any;
    const p2 = { kill: vi.fn(), exitCode: null, killed: false } as any;
    registry.register(1, p1);
    registry.register(2, p2);

    const all = registry.getAll();
    expect(all.size).toBe(2);
    expect(all.get(1)).toBe(p1);
    expect(all.get(2)).toBe(p2);
  });

  it('cleanup removes finished processes and returns their ids', () => {
    const registry = createProcessRegistry();
    const running = { kill: vi.fn(), exitCode: null, killed: false } as any;
    const exited = { kill: vi.fn(), exitCode: 0, killed: false } as any;
    const killed = { kill: vi.fn(), exitCode: null, killed: true } as any;

    registry.register(1, running);
    registry.register(2, exited);
    registry.register(3, killed);

    const cleaned = registry.cleanup();
    expect(cleaned.sort()).toEqual([2, 3]);
    expect(registry.get(1)).toBe(running);
    expect(registry.get(2)).toBeUndefined();
    expect(registry.get(3)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Session status / kill (no actual process spawning)
// ---------------------------------------------------------------------------

describe('agents service — session management', () => {
  let db: Database;
  let accounts: AccountsService;
  let service: AgentsService;
  let processRegistry: ProcessRegistry;

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    processRegistry = createProcessRegistry();
    service = createAgentsService(
      db,
      accounts,
      makeClaudeBinaryService(),
      processRegistry,
      makeSendToRenderer(),
    );
  });

  afterEach(() => {
    db.close();
  });

  it('getSessionStatus returns unknown for non-existent run', () => {
    expect(service.getSessionStatus(9999)).toBe('unknown');
  });

  it('getSessionStatus returns db status when not in registry', () => {
    const agent = service.createAgent({ name: 'A', icon: '🤖', system_prompt: 'P' });
    const info = db.raw
      .prepare(
        `INSERT INTO agent_runs
         (agent_id, agent_name, agent_icon, task, model, project_path, session_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(agent.id, agent.name, agent.icon, 'T', 'sonnet', '/p', 'sid', 'completed');
    const runId = info.lastInsertRowid as number;

    expect(service.getSessionStatus(runId)).toBe('completed');
  });

  it('getSessionStatus reflects running process in registry', () => {
    const agent = service.createAgent({ name: 'A', icon: '🤖', system_prompt: 'P' });
    const info = db.raw
      .prepare(
        `INSERT INTO agent_runs
         (agent_id, agent_name, agent_icon, task, model, project_path, session_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(agent.id, agent.name, agent.icon, 'T', 'sonnet', '/p', 'sid', 'running');
    const runId = info.lastInsertRowid as number;

    const mockProc = { kill: vi.fn(), exitCode: null, killed: false } as any;
    processRegistry.register(runId, mockProc);

    expect(service.getSessionStatus(runId)).toBe('running');
  });

  it('killAgentSession kills process and updates status', () => {
    const agent = service.createAgent({ name: 'A', icon: '🤖', system_prompt: 'P' });
    const info = db.raw
      .prepare(
        `INSERT INTO agent_runs
         (agent_id, agent_name, agent_icon, task, model, project_path, session_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(agent.id, agent.name, agent.icon, 'T', 'sonnet', '/p', 'sid', 'running');
    const runId = info.lastInsertRowid as number;

    const mockProc = { kill: vi.fn(), exitCode: null, killed: false } as any;
    processRegistry.register(runId, mockProc);

    service.killAgentSession(runId);

    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
    const run = service.getAgentRun(runId);
    expect(run!.status).toBe('killed');
  });

  it('getSessionOutput returns empty string', () => {
    expect(service.getSessionOutput(1)).toBe('');
  });

  it('getLiveSessionOutput returns empty string', () => {
    expect(service.getLiveSessionOutput(1)).toBe('');
  });

  it('streamSessionOutput is a no-op (does not throw)', () => {
    expect(() => service.streamSessionOutput(1)).not.toThrow();
  });

  it('cleanupFinishedProcesses updates db for cleaned runs', () => {
    const agent = service.createAgent({ name: 'A', icon: '🤖', system_prompt: 'P' });
    const info = db.raw
      .prepare(
        `INSERT INTO agent_runs
         (agent_id, agent_name, agent_icon, task, model, project_path, session_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(agent.id, agent.name, agent.icon, 'T', 'sonnet', '/p', 'sid', 'running');
    const runId = info.lastInsertRowid as number;

    const exitedProc = { kill: vi.fn(), exitCode: 0, killed: false } as any;
    processRegistry.register(runId, exitedProc);

    const cleaned = service.cleanupFinishedProcesses();
    expect(cleaned).toContain(runId);

    const run = service.getAgentRun(runId);
    expect(run!.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// GitHub agent fetch / import
// ---------------------------------------------------------------------------

describe('agents service — GitHub integration', () => {
  let db: Database;
  let accounts: AccountsService;
  let service: AgentsService;
  let processRegistry: ProcessRegistry;
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    processRegistry = createProcessRegistry();
    service = createAgentsService(
      db,
      accounts,
      makeClaudeBinaryService(),
      processRegistry,
      makeSendToRenderer(),
    );

    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  it('fetchGitHubAgents returns the parsed GitHub contents list', async () => {
    const payload = [
      {
        name: 'coder.json',
        path: 'agents/coder.json',
        type: 'file',
        download_url: 'https://example.test/coder.json',
      },
      {
        name: 'writer.json',
        path: 'agents/writer.json',
        type: 'file',
        download_url: 'https://example.test/writer.json',
      },
    ];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => payload,
    });

    const result = await service.fetchGitHubAgents();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOptions] = fetchMock.mock.calls[0];
    expect(calledUrl).toContain('api.github.com');
    expect(calledUrl).toContain('contents');
    expect((calledOptions as any).headers.Accept).toBe(
      'application/vnd.github.v3+json',
    );
    expect(result).toEqual(payload);
  });

  it('fetchGitHubAgents throws a descriptive error on non-OK response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    await expect(service.fetchGitHubAgents()).rejects.toThrow(/403/);
  });

  it('fetchGitHubAgentContent returns the response body as text', async () => {
    const body = JSON.stringify({
      name: 'Remote Agent',
      icon: '🌐',
      system_prompt: 'Remote prompt.',
      model: 'sonnet',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => body,
    });

    const result = await service.fetchGitHubAgentContent(
      'https://example.test/remote.json',
    );
    expect(result).toBe(body);
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/remote.json');
  });

  it('fetchGitHubAgentContent throws on non-OK response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(
      service.fetchGitHubAgentContent('https://example.test/gone.json'),
    ).rejects.toThrow(/404/);
  });

  it('importAgentFromGitHub fetches and imports a remote agent definition', async () => {
    const body = JSON.stringify({
      name: 'GitHub Imported',
      icon: '⭐',
      system_prompt: 'From GH.',
      model: 'opus',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => body,
    });

    const imported = await service.importAgentFromGitHub(
      'https://example.test/gh.json',
    );

    expect(imported.name).toBe('GitHub Imported');
    expect(imported.icon).toBe('⭐');
    expect(imported.model).toBe('opus');
    // And it was persisted
    expect(service.listAgents()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// executeAgent — the spawn path
// ---------------------------------------------------------------------------

describe('agents service — executeAgent spawn path', () => {
  let db: Database;
  let accounts: AccountsService;
  let service: AgentsService;
  let processRegistry: ProcessRegistry;
  let claudeBinary: ReturnType<typeof makeClaudeBinaryService>;
  let sendToRenderer: ReturnType<typeof makeSendToRenderer>;

  const projectPath = '/tmp/exec-test';
  const configDir = '/fake/.claude';

  beforeEach(() => {
    mockedSpawn.mockReset();
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    processRegistry = createProcessRegistry();
    claudeBinary = makeClaudeBinaryService('/usr/local/bin/claude');
    sendToRenderer = makeSendToRenderer();
    service = createAgentsService(
      db,
      accounts,
      claudeBinary,
      processRegistry,
      sendToRenderer,
    );

    // Seed an account + path rule so resolve() succeeds for projectPath
    const account = accounts.createAccount('Work', configDir, true, 'pro');
    accounts.addPathRule(account.id, projectPath);
  });

  afterEach(() => {
    db.close();
  });

  // ---- error paths ----

  it('throws when the agent id is unknown', async () => {
    await expect(
      service.executeAgent({
        agentId: 9999,
        projectPath,
        task: 'doit',
      }),
    ).rejects.toThrow(/Agent 9999 not found/);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('throws when no account resolves for the project path', async () => {
    const agent = service.createAgent({
      name: 'A',
      icon: '🤖',
      system_prompt: 'P',
    });

    await expect(
      service.executeAgent({
        agentId: agent.id,
        projectPath: '/somewhere/else',
        task: 'doit',
      }),
    ).rejects.toThrow(/No account resolved/);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('throws when no claude binary can be found', async () => {
    const agent = service.createAgent({
      name: 'A',
      icon: '🤖',
      system_prompt: 'P',
    });
    (claudeBinary.findBestBinary as any).mockReturnValue(null);

    await expect(
      service.executeAgent({
        agentId: agent.id,
        projectPath,
        task: 'doit',
      }),
    ).rejects.toThrow(/No Claude binary/);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  // ---- happy path ----

  it('spawns claude with the agent prompt, model, task, cwd, and CLAUDE_CONFIG_DIR', async () => {
    const agent = service.createAgent({
      name: 'Spawner',
      icon: '🚀',
      system_prompt: 'System prompt text',
      model: 'sonnet',
    });
    const { proc } = createFakeProcess({ pid: 4242 });
    mockedSpawn.mockReturnValueOnce(proc);

    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 'run this task',
      model: 'opus', // override agent default
    });

    // spawn called once with the right arguments
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    const [binary, args, options] = mockedSpawn.mock.calls[0] as any[];
    expect(binary).toBe('/usr/local/bin/claude');
    expect(args).toContain('--system-prompt');
    expect(args).toContain('System prompt text');
    expect(args).toContain('--model');
    expect(args).toContain('opus'); // override was honored
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('-p');
    expect(args).toContain('run this task');
    expect(options.cwd).toBe(projectPath);
    expect(options.env.CLAUDE_CONFIG_DIR).toBe(configDir);

    // Run record exists, in running status, with pid
    const run = service.getAgentRun(runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('running');
    expect(run!.pid).toBe(4242);
    expect(run!.task).toBe('run this task');
    expect(run!.model).toBe('opus');
    expect(run!.project_path).toBe(projectPath);

    // Registered in the process registry
    expect(processRegistry.get(runId)).toBe(proc);
  });

  it('falls back to the agent default model when params.model is not provided', async () => {
    const agent = service.createAgent({
      name: 'Defaulty',
      icon: '🧭',
      system_prompt: 'P',
      model: 'haiku',
    });
    const { proc } = createFakeProcess();
    mockedSpawn.mockReturnValueOnce(proc);

    await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    const [, args] = mockedSpawn.mock.calls[0] as any[];
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('haiku');
  });

  it('skips the pid update when the spawned process has no pid', async () => {
    const agent = service.createAgent({
      name: 'NoPid',
      icon: '🔇',
      system_prompt: 'P',
    });
    const { proc } = createFakeProcess({ pid: null });
    mockedSpawn.mockReturnValueOnce(proc);

    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    const run = service.getAgentRun(runId);
    expect(run!.pid).toBeNull();
  });

  it('streams stdout lines to the renderer on claude-output:<runId>', async () => {
    const agent = service.createAgent({
      name: 'Streamer',
      icon: '📡',
      system_prompt: 'P',
    });
    const handle = createFakeProcess();
    mockedSpawn.mockReturnValueOnce(handle.proc);

    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    handle.pushLine('{"type":"text","text":"hi"}');
    handle.pushLine('{"type":"text","text":"there"}');
    await flush();

    const outputCalls = sendToRenderer.mock.calls.filter(
      (c) => c[0] === `claude-output:${runId}`,
    );
    expect(outputCalls.length).toBeGreaterThanOrEqual(2);
    expect(outputCalls[0][1]).toBe('{"type":"text","text":"hi"}');
    expect(outputCalls[1][1]).toBe('{"type":"text","text":"there"}');
  });

  it('does not install a stdout listener when the process has no stdout', async () => {
    const agent = service.createAgent({
      name: 'Silent',
      icon: '🤫',
      system_prompt: 'P',
    });
    const { proc } = createFakeProcess({ noStdout: true });
    mockedSpawn.mockReturnValueOnce(proc);

    await expect(
      service.executeAgent({
        agentId: agent.id,
        projectPath,
        task: 't',
      }),
    ).resolves.toBeTypeOf('number');
  });

  it('marks status as completed when the process exits with code 0', async () => {
    const agent = service.createAgent({
      name: 'Happy',
      icon: '✅',
      system_prompt: 'P',
    });
    const handle = createFakeProcess();
    mockedSpawn.mockReturnValueOnce(handle.proc);

    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    handle.emitClose(0);
    await flush();

    const run = service.getAgentRun(runId);
    expect(run!.status).toBe('completed');
    expect(run!.completed_at).not.toBeNull();
    // Process removed from registry
    expect(processRegistry.get(runId)).toBeUndefined();
  });

  it('marks status as failed when the process exits with a non-zero code', async () => {
    const agent = service.createAgent({
      name: 'Sad',
      icon: '❌',
      system_prompt: 'P',
    });
    const handle = createFakeProcess();
    mockedSpawn.mockReturnValueOnce(handle.proc);

    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    handle.emitClose(1);
    await flush();

    const run = service.getAgentRun(runId);
    expect(run!.status).toBe('failed');
  });

  it('killing a spawned run via killAgentSession sends SIGTERM and updates status', async () => {
    const agent = service.createAgent({
      name: 'Killable',
      icon: '🗡️',
      system_prompt: 'P',
    });
    const handle = createFakeProcess();
    mockedSpawn.mockReturnValueOnce(handle.proc);

    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    service.killAgentSession(runId);

    expect(handle.proc.kill).toHaveBeenCalledWith('SIGTERM');
    const run = service.getAgentRun(runId);
    expect(run!.status).toBe('killed');
  });
});

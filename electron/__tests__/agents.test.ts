import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService, type AccountsService } from '../services/accounts';
import { createAgentsService, type AgentsService, type Agent } from '../services/agents';
import {
  createAgentRunRegistry,
  type AgentRunRegistry,
} from '../services/agent-run-registry';
import { createAsyncChannel } from '../services/async-channel';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Mock the Claude Agent SDK (same pattern as sessions.test.ts)
// ---------------------------------------------------------------------------

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

const mockedQuery = vi.mocked(sdkQuery);

// ---------------------------------------------------------------------------
// Fake SDK Query handle: an async-iterable with a `close()` method, driven
// by an internal AsyncChannel so tests can push SDKMessage-shaped objects
// into the stream at will.
// ---------------------------------------------------------------------------

interface FakeQueryHandle {
  query: any;
  pushMessage: (msg: unknown) => void;
  closeMessages: () => void;
  wasClosed: () => boolean;
  getCapturedOptions: () => any;
  getCapturedPrompt: () => any;
}

function installFakeQuery(): FakeQueryHandle {
  const channel = createAsyncChannel<unknown>();
  let closed = false;
  let capturedArgs: any = null;

  const fakeQuery: any = {
    [Symbol.asyncIterator]: () => channel[Symbol.asyncIterator](),
    close: vi.fn(() => {
      closed = true;
      channel.close();
    }),
    interrupt: vi.fn(),
  };

  mockedQuery.mockImplementation((args: any) => {
    capturedArgs = args ?? null;
    return fakeQuery;
  });

  return {
    query: fakeQuery,
    pushMessage: (msg) => channel.push(msg),
    closeMessages: () => channel.close(),
    wasClosed: () => closed,
    getCapturedOptions: () => capturedArgs?.options ?? null,
    getCapturedPrompt: () => capturedArgs?.prompt ?? null,
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
  let agentRunRegistry: AgentRunRegistry;

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    agentRunRegistry = createAgentRunRegistry();
    service = createAgentsService(
      db,
      accounts,
      makeClaudeBinaryService(),
      agentRunRegistry,
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

  it('exportAgentToFile writes the agent JSON to the given path', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greychrist-agent-export-'));
    const target = path.join(tmpDir, 'agent.greychrist.json');

    try {
      const agent = service.createAgent({
        name: 'Exportable',
        icon: '📤',
        system_prompt: 'Export me.',
        model: 'haiku',
      });

      service.exportAgentToFile(agent.id, target);

      const written = fs.readFileSync(target, 'utf-8');
      const parsed = JSON.parse(written) as Agent;
      expect(parsed.name).toBe('Exportable');
      expect(parsed.system_prompt).toBe('Export me.');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exportAgentToFile throws for unknown id without writing', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greychrist-agent-export-'));
    const target = path.join(tmpDir, 'missing.json');

    try {
      expect(() => service.exportAgentToFile(9999, target)).toThrow(/not found/i);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
  let agentRunRegistry: AgentRunRegistry;

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    agentRunRegistry = createAgentRunRegistry();
    service = createAgentsService(
      db,
      accounts,
      makeClaudeBinaryService(),
      agentRunRegistry,
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
// Agent run registry (replaces the old ChildProcess-based ProcessRegistry)
// ---------------------------------------------------------------------------

describe('agent run registry', () => {
  function makeFakeHandle(): any {
    return {
      query: { close: vi.fn() },
      status: 'running' as const,
    };
  }

  it('registers and retrieves a handle', () => {
    const registry = createAgentRunRegistry();
    const h = makeFakeHandle();
    registry.register(1, h);
    expect(registry.get(1)).toBe(h);
  });

  it('returns undefined for unregistered run id', () => {
    const registry = createAgentRunRegistry();
    expect(registry.get(999)).toBeUndefined();
  });

  it('kill marks status and calls query.close()', () => {
    const registry = createAgentRunRegistry();
    const h = makeFakeHandle();
    registry.register(42, h);

    const result = registry.kill(42);
    expect(result).toBe(true);
    expect(h.query.close).toHaveBeenCalledTimes(1);
    expect(h.status).toBe('killed');
    // kill() no longer removes from registry — it leaves the handle so
    // cleanupFinishedProcesses can include it in the next sweep
    expect(registry.get(42)).toBe(h);
  });

  it('kill returns false for unknown run id', () => {
    const registry = createAgentRunRegistry();
    expect(registry.kill(999)).toBe(false);
  });

  it('kill swallows errors from query.close()', () => {
    const registry = createAgentRunRegistry();
    const h = {
      query: { close: vi.fn(() => { throw new Error('already closed'); }) },
      status: 'running' as const,
    };
    registry.register(5, h as any);
    expect(() => registry.kill(5)).not.toThrow();
    expect(h.status).toBe('killed');
  });

  it('setStatus updates the status of an existing entry', () => {
    const registry = createAgentRunRegistry();
    const h = makeFakeHandle();
    registry.register(1, h);
    registry.setStatus(1, 'completed');
    expect(h.status).toBe('completed');
  });

  it('setStatus is a no-op for an unknown run id', () => {
    const registry = createAgentRunRegistry();
    expect(() => registry.setStatus(999, 'completed')).not.toThrow();
  });

  it('remove deletes from registry', () => {
    const registry = createAgentRunRegistry();
    const h = makeFakeHandle();
    registry.register(7, h);
    registry.remove(7);
    expect(registry.get(7)).toBeUndefined();
  });

  it('getAll returns all registered handles', () => {
    const registry = createAgentRunRegistry();
    const h1 = makeFakeHandle();
    const h2 = makeFakeHandle();
    registry.register(1, h1);
    registry.register(2, h2);

    const all = registry.getAll();
    expect(all.size).toBe(2);
    expect(all.get(1)).toBe(h1);
    expect(all.get(2)).toBe(h2);
  });

  it('cleanup removes non-running entries and returns their ids', () => {
    const registry = createAgentRunRegistry();
    const running = makeFakeHandle();
    const completed = { ...makeFakeHandle(), status: 'completed' as const };
    const killed = { ...makeFakeHandle(), status: 'killed' as const };

    registry.register(1, running);
    registry.register(2, completed);
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
  let agentRunRegistry: AgentRunRegistry;

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    agentRunRegistry = createAgentRunRegistry();
    service = createAgentsService(
      db,
      accounts,
      makeClaudeBinaryService(),
      agentRunRegistry,
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

  it('getSessionStatus reflects running handle in registry', () => {
    const agent = service.createAgent({ name: 'A', icon: '🤖', system_prompt: 'P' });
    const info = db.raw
      .prepare(
        `INSERT INTO agent_runs
         (agent_id, agent_name, agent_icon, task, model, project_path, session_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(agent.id, agent.name, agent.icon, 'T', 'sonnet', '/p', 'sid', 'running');
    const runId = info.lastInsertRowid as number;

    const handle = { query: { close: vi.fn() }, status: 'running' as const } as any;
    agentRunRegistry.register(runId, handle);

    expect(service.getSessionStatus(runId)).toBe('running');
  });

  it('killAgentSession calls query.close() and updates status', () => {
    const agent = service.createAgent({ name: 'A', icon: '🤖', system_prompt: 'P' });
    const info = db.raw
      .prepare(
        `INSERT INTO agent_runs
         (agent_id, agent_name, agent_icon, task, model, project_path, session_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(agent.id, agent.name, agent.icon, 'T', 'sonnet', '/p', 'sid', 'running');
    const runId = info.lastInsertRowid as number;

    const close = vi.fn();
    const handle = { query: { close }, status: 'running' as const } as any;
    agentRunRegistry.register(runId, handle);

    service.killAgentSession(runId);

    expect(close).toHaveBeenCalledTimes(1);
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

    // Register with non-running status so cleanup picks it up
    const completedHandle = {
      query: { close: vi.fn() },
      status: 'completed' as const,
    } as any;
    agentRunRegistry.register(runId, completedHandle);

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
  let agentRunRegistry: AgentRunRegistry;
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    agentRunRegistry = createAgentRunRegistry();
    service = createAgentsService(
      db,
      accounts,
      makeClaudeBinaryService(),
      agentRunRegistry,
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

describe('agents service — executeAgent SDK path', () => {
  let db: Database;
  let accounts: AccountsService;
  let service: AgentsService;
  let agentRunRegistry: AgentRunRegistry;
  let claudeBinary: ReturnType<typeof makeClaudeBinaryService>;
  let sendToRenderer: ReturnType<typeof makeSendToRenderer>;

  const projectPath = '/tmp/exec-test';
  const configDir = '/fake/.claude';

  beforeEach(() => {
    mockedQuery.mockReset();
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    agentRunRegistry = createAgentRunRegistry();
    claudeBinary = makeClaudeBinaryService('/usr/local/bin/claude');
    sendToRenderer = makeSendToRenderer();
    service = createAgentsService(
      db,
      accounts,
      claudeBinary,
      agentRunRegistry,
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
    expect(mockedQuery).not.toHaveBeenCalled();
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
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  // ---- happy path ----

  it('calls SDK query() with the agent system prompt, model, task, cwd, and CLAUDE_CONFIG_DIR', async () => {
    const agent = service.createAgent({
      name: 'Runner',
      icon: '🏃',
      system_prompt: 'System prompt text',
      model: 'sonnet',
    });
    installFakeQuery();

    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 'run this task',
      model: 'opus', // override agent default
    });

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const callArg = mockedQuery.mock.calls[0][0] as any;
    expect(callArg.prompt).toBe('run this task');
    expect(callArg.options.systemPrompt).toBe('System prompt text');
    expect(callArg.options.model).toBe('opus');
    expect(callArg.options.cwd).toBe(projectPath);
    expect(callArg.options.env.CLAUDE_CONFIG_DIR).toBe(configDir);
    expect(callArg.options.settingSources).toEqual(['user', 'project', 'local']);
    expect(callArg.options.strictMcpConfig).toBeFalsy();

    // Run record exists, in running status
    const run = service.getAgentRun(runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('running');
    expect(run!.task).toBe('run this task');
    expect(run!.model).toBe('opus');
    expect(run!.project_path).toBe(projectPath);

    // Registered in the agent-run registry
    const handle = agentRunRegistry.get(runId);
    expect(handle).toBeDefined();
    expect(handle!.status).toBe('running');
  });

  it("defaults permissionMode to 'acceptEdits' (not bypassPermissions)", async () => {
    // Regression guard: we explicitly DO NOT want agents to auto-approve
    // destructive ops by default. acceptEdits auto-approves Read/Write/Edit
    // so the agent can make progress, but still prompts for Bash and
    // other dangerous tools. bypassPermissions would be unsafe.
    const agent = service.createAgent({
      name: 'Safe',
      icon: '🛡️',
      system_prompt: 'P',
    });
    installFakeQuery();

    await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    const callArg = mockedQuery.mock.calls[0][0] as any;
    expect(callArg.options.permissionMode).toBe('acceptEdits');
    expect(callArg.options.permissionMode).not.toBe('bypassPermissions');
  });

  it('enables agentProgressSummaries so the SDK emits task_progress events for nested subagents', async () => {
    const agent = service.createAgent({
      name: 'Progressy',
      icon: '📈',
      system_prompt: 'P',
    });
    installFakeQuery();

    await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    const callArg = mockedQuery.mock.calls[0][0] as any;
    expect(callArg.options.agentProgressSummaries).toBe(true);
  });

  it('falls back to the agent default model when params.model is not provided', async () => {
    const agent = service.createAgent({
      name: 'Defaulty',
      icon: '🧭',
      system_prompt: 'P',
      model: 'haiku',
    });
    installFakeQuery();

    await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    const callArg = mockedQuery.mock.calls[0][0] as any;
    expect(callArg.options.model).toBe('haiku');
  });

  it('forwards each SDK message to the renderer on agent-output:<runId> as a JSON string', async () => {
    const agent = service.createAgent({
      name: 'Streamer',
      icon: '📡',
      system_prompt: 'P',
    });
    const fake = installFakeQuery();

    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    fake.pushMessage({ type: 'system', subtype: 'init', session_id: 'abc' });
    fake.pushMessage({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    });
    await flush();

    const outputCalls = sendToRenderer.mock.calls.filter(
      (c) => c[0] === `agent-output:${runId}`,
    );
    expect(outputCalls.length).toBeGreaterThanOrEqual(2);
    // Each payload is JSON.stringified so renderer's existing JSON.parse works
    expect(typeof outputCalls[0][1]).toBe('string');
    const first = JSON.parse(outputCalls[0][1] as string);
    expect(first.type).toBe('system');
    const second = JSON.parse(outputCalls[1][1] as string);
    expect(second.type).toBe('assistant');
  });

  it("skips root user messages (parent_tool_use_id null) so the task prompt isn't echoed", async () => {
    // Regression guard: the SDK's query() emits a type:'user' message at
    // the top of the stream to represent the initial prompt. For
    // interactive sessions that's correct (the user did type it), but for
    // agents it shows up as "you said <the task>" which is confusing. We
    // filter those out based on parent_tool_use_id === null.
    const agent = service.createAgent({
      name: 'Silent',
      icon: '🤐',
      system_prompt: 'P',
    });
    const fake = installFakeQuery();

    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 'do the thing',
    });

    // Root user message — the prompt echo. Should NOT reach the renderer.
    fake.pushMessage({
      type: 'user',
      message: { role: 'user', content: 'do the thing' },
      parent_tool_use_id: null,
    });
    // Assistant reply — should reach the renderer.
    fake.pushMessage({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
    });
    await flush();

    const outputCalls = sendToRenderer.mock.calls.filter(
      (c) => c[0] === `agent-output:${runId}`,
    );
    // Only the assistant message should have been forwarded
    expect(outputCalls.length).toBe(1);
    const parsed = JSON.parse(outputCalls[0][1] as string);
    expect(parsed.type).toBe('assistant');
  });

  it('forwards user messages that ARE tool results (non-null parent_tool_use_id)', async () => {
    const agent = service.createAgent({
      name: 'ToolUser',
      icon: '🔧',
      system_prompt: 'P',
    });
    const fake = installFakeQuery();

    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    // Tool result user message — SDK wraps tool responses this way.
    fake.pushMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'output' }],
      },
      parent_tool_use_id: 'tu-1',
    });
    await flush();

    const outputCalls = sendToRenderer.mock.calls.filter(
      (c) => c[0] === `agent-output:${runId}`,
    );
    expect(outputCalls.length).toBe(1);
    const parsed = JSON.parse(outputCalls[0][1] as string);
    expect(parsed.type).toBe('user');
    expect(parsed.parent_tool_use_id).toBe('tu-1');
  });

  it('marks status as completed and fires agent-complete when a result message arrives', async () => {
    const agent = service.createAgent({
      name: 'Happy',
      icon: '✅',
      system_prompt: 'P',
    });
    const fake = installFakeQuery();

    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    fake.pushMessage({ type: 'result', result: 'done', is_error: false });
    fake.closeMessages();
    await flush();

    const run = service.getAgentRun(runId);
    expect(run!.status).toBe('completed');
    expect(run!.completed_at).not.toBeNull();
    // agent-complete event fired
    const completeCalls = sendToRenderer.mock.calls.filter(
      (c) => c[0] === `agent-complete:${runId}`,
    );
    expect(completeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('marks status as failed and fires agent-error when the stream throws', async () => {
    const agent = service.createAgent({
      name: 'Sad',
      icon: '❌',
      system_prompt: 'P',
    });
    const throwingQuery: any = {
      async *[Symbol.asyncIterator]() {
        throw new Error('subprocess blew up');
      },
      close: vi.fn(),
      interrupt: vi.fn(),
    };
    mockedQuery.mockReturnValueOnce(throwingQuery);

    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    await flush(4);

    const run = service.getAgentRun(runId);
    expect(run!.status).toBe('failed');
    const errorCalls = sendToRenderer.mock.calls.filter(
      (c) => c[0] === `agent-error:${runId}`,
    );
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(errorCalls[0][1])).toContain('subprocess blew up');
  });

  it('marks a result with is_error=true as failed', async () => {
    const agent = service.createAgent({
      name: 'Err',
      icon: '⚠️',
      system_prompt: 'P',
    });
    const fake = installFakeQuery();

    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    fake.pushMessage({ type: 'result', error: 'something broke', is_error: true });
    fake.closeMessages();
    await flush();

    const run = service.getAgentRun(runId);
    expect(run!.status).toBe('failed');
  });

  it('killing a running agent via killAgentSession calls query.close() and fires agent-cancelled', async () => {
    const agent = service.createAgent({
      name: 'Killable',
      icon: '🗡️',
      system_prompt: 'P',
    });
    const fake = installFakeQuery();

    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath,
      task: 't',
    });

    service.killAgentSession(runId);

    expect(fake.query.close).toHaveBeenCalledTimes(1);
    const run = service.getAgentRun(runId);
    expect(run!.status).toBe('killed');
    const cancelledCalls = sendToRenderer.mock.calls.filter(
      (c) => c[0] === `agent-cancelled:${runId}`,
    );
    expect(cancelledCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Per-window ownership hook
// ---------------------------------------------------------------------------

describe('agents service — ownership hook', () => {
  let db: Database;
  let accounts: AccountsService;
  let service: AgentsService;
  let agentRunRegistry: AgentRunRegistry;
  let ownership: { register: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = createDatabase(':memory:');
    accounts = createAccountsService(db);
    agentRunRegistry = createAgentRunRegistry();
    ownership = { register: vi.fn(), unregister: vi.fn() };
    service = createAgentsService(
      db,
      accounts,
      makeClaudeBinaryService(),
      agentRunRegistry,
      makeSendToRenderer(),
      ownership as any,
    );
    const account = accounts.createAccount('Default', '/config', true, 'pro');
    accounts.addPathRule(account.id, '/p');
  });

  afterEach(() => {
    db.close();
  });

  it('registers the owner when executeAgent is given ownerWebContentsId', async () => {
    installFakeQuery();
    const agent = service.createAgent({ name: 'A', icon: '🤖', system_prompt: 'P' });
    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath: '/p',
      task: 'do it',
      ownerWebContentsId: 42,
    });
    expect(ownership.register).toHaveBeenCalledWith(String(runId), 42);
  });

  it('unregisters on killAgentSession', async () => {
    installFakeQuery();
    const agent = service.createAgent({ name: 'A', icon: '🤖', system_prompt: 'P' });
    const runId = await service.executeAgent({
      agentId: agent.id,
      projectPath: '/p',
      task: 'do it',
      ownerWebContentsId: 42,
    });
    service.killAgentSession(runId);
    expect(ownership.unregister).toHaveBeenCalledWith(String(runId));
  });

  it('does not register when ownerWebContentsId is omitted', async () => {
    installFakeQuery();
    const agent = service.createAgent({ name: 'A', icon: '🤖', system_prompt: 'P' });
    await service.executeAgent({
      agentId: agent.id,
      projectPath: '/p',
      task: 'do it',
    });
    expect(ownership.register).not.toHaveBeenCalled();
  });
});

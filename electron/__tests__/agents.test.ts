import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService, type AccountsService } from '../services/accounts';
import { createAgentsService, type AgentsService, type Agent } from '../services/agents';
import { createProcessRegistry, type ProcessRegistry } from '../services/process-registry';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

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

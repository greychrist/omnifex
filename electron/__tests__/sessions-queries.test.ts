// @vitest-environment node
//
// The control-protocol passthrough layer (sessions/queries.ts).
//
// Every method here swallows engine errors and reports null/[] so a CLI
// hiccup can't crash the IPC layer. That is the right posture and also the
// reason this file went untested for so long: when it breaks, nothing says
// so. The `logControl` rows in app_logs are the ONLY trace a mid-session
// setting change left, which is exactly why the "silently no-op" bugs
// (effort / permission / model) were so hard to find the first time.
//
// So the assertions here are deliberately about the two things that are
// invisible at runtime: which control_request went out with which payload,
// and what got written to the log when one didn't.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createQueryPassthroughs } from '../services/sessions/queries';
import type { AgentEngine } from '../services/agents/types';
import type { SessionHandle, SendToRenderer } from '../services/sessions/types';
import type { LoggingService } from '../services/logging';

type ControlCall = { subtype: string; payload: unknown };

function createEngine(opts: {
  control?: (subtype: string, payload: unknown) => unknown;
  initData?: unknown;
  interrupt?: () => Promise<void>;
} = {}) {
  const calls: ControlCall[] = [];
  const engine = {
    kind: 'claude',
    sendControlRequest: vi.fn(async (subtype: string, payload?: unknown) => {
      calls.push({ subtype, payload });
      return opts.control ? opts.control(subtype, payload) : undefined;
    }),
    getInitData: vi.fn(() => opts.initData ?? null),
    interrupt: vi.fn(opts.interrupt ?? (async () => {})),
  } as unknown as AgentEngine;
  return { engine, calls };
}

function handle(engine: AgentEngine | null, mode: 'rich' | 'tui' = 'rich'): SessionHandle {
  return {
    agent: 'claude',
    engine,
    mode,
    initData: null,
    permissionMode: 'default',
    configDir: '/cfg',
    projectPath: '/proj',
  } as unknown as SessionHandle;
}

/** Captures what would have been persisted to app_logs. */
function createLogging() {
  const rows: Record<string, unknown>[] = [];
  const logging = {
    writeBatch: vi.fn((batch: Record<string, unknown>[]) => {
      rows.push(...batch);
    }),
  } as unknown as LoggingService;
  /** The parsed `metadata` blob of the nth control row. */
  const meta = (n = 0) => JSON.parse(rows[n].metadata as string) as Record<string, unknown>;
  return { logging, rows, meta };
}

function setup(opts: {
  engine?: AgentEngine | null;
  mode?: 'rich' | 'tui';
  registered?: boolean;
} = {}) {
  const sessions = new Map<string, SessionHandle>();
  if (opts.registered !== false) {
    sessions.set('tab1', handle(opts.engine ?? null, opts.mode ?? 'rich'));
  }
  const sent: { channel: string; args: unknown[] }[] = [];
  const sendToRenderer: SendToRenderer = (channel, ...args) => {
    sent.push({ channel, args });
  };
  const { logging, rows, meta } = createLogging();
  const q = createQueryPassthroughs(sessions, sendToRenderer, logging);
  return { q, sessions, sent, rows, meta };
}

beforeEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// liveEngine: the gate every control_request passes through
// ---------------------------------------------------------------------------

describe('live-engine gating', () => {
  // TUI mode speaks to the CLI over the PTY, and the CLI owns model /
  // permission there (the OmniFex pickers are read-only mirrors). Firing a
  // control_request at a TUI tab would be talking to a channel nobody reads.
  it('treats a TUI tab as having no live engine', async () => {
    const { engine, calls } = createEngine();
    const { q, meta } = setup({ engine, mode: 'tui' });
    await q.setModel('tab1', 'claude-opus-5');
    expect(calls).toEqual([]);
    expect(meta().reason).toBe('no-live-engine');
  });

  it('treats an unknown tab as having no live engine', async () => {
    const { q, meta } = setup({ registered: false });
    await q.setModel('tab1', 'claude-opus-5');
    expect(meta().reason).toBe('no-live-engine');
  });

  it('treats a registered tab with no engine as having no live engine', async () => {
    const { q, meta } = setup({ engine: null });
    await q.setModel('tab1', 'claude-opus-5');
    expect(meta().reason).toBe('no-live-engine');
  });
});

// ---------------------------------------------------------------------------
// Control requests — wire subtype + payload
// ---------------------------------------------------------------------------

describe('setModel', () => {
  it('sends set_model and logs the round trip', async () => {
    const { engine, calls } = createEngine({ control: () => ({ ok: true }) });
    const { q, meta } = setup({ engine });
    await q.setModel('tab1', 'claude-opus-5');
    expect(calls).toEqual([{ subtype: 'set_model', payload: { model: 'claude-opus-5' } }]);
    expect(meta()).toMatchObject({ op: 'set_model', ok: true, model: 'claude-opus-5' });
  });

  // An undefined model is "use the account default" — the CLI reads the
  // absent key, so it must still go out rather than being short-circuited.
  it('sends an undefined model rather than skipping the request', async () => {
    const { engine, calls } = createEngine();
    const { q } = setup({ engine });
    await q.setModel('tab1');
    expect(calls).toEqual([{ subtype: 'set_model', payload: { model: undefined } }]);
  });

  it('records the engine error instead of throwing', async () => {
    const { engine } = createEngine({
      control: () => {
        throw new Error('control channel closed');
      },
    });
    const { q, meta } = setup({ engine });
    await expect(q.setModel('tab1', 'x')).resolves.toBeUndefined();
    expect(meta()).toMatchObject({ ok: false, error: 'control channel closed' });
  });
});

describe('setPermissionMode', () => {
  it('sends set_permission_mode and updates the remembered mode', async () => {
    const { engine, calls } = createEngine();
    const { q, sessions } = setup({ engine });
    await q.setPermissionMode('tab1', 'acceptEdits');
    expect(calls).toEqual([
      { subtype: 'set_permission_mode', payload: { mode: 'acceptEdits' } },
    ]);
    expect(sessions.get('tab1')!.permissionMode).toBe('acceptEdits');
  });

  // The handle is updated BEFORE the request. A failed send must not roll it
  // back: the restart path reads permissionMode, and reverting would restart
  // the session under a mode the user had already left.
  it('keeps the remembered mode even when the request fails', async () => {
    const { engine } = createEngine({
      control: () => {
        throw new Error('nope');
      },
    });
    const { q, sessions, meta } = setup({ engine });
    await q.setPermissionMode('tab1', 'plan');
    expect(sessions.get('tab1')!.permissionMode).toBe('plan');
    expect(meta()).toMatchObject({ op: 'set_permission_mode', ok: false, error: 'nope' });
  });

  it('does not touch the remembered mode when there is no live engine', async () => {
    const { q, sessions } = setup({ engine: null });
    await q.setPermissionMode('tab1', 'plan');
    expect(sessions.get('tab1')!.permissionMode).toBe('default');
  });
});

describe('setEffort', () => {
  // Effort rides apply_flag_settings, NOT a set_effort subtype.
  it('sends effortLevel through apply_flag_settings', async () => {
    const { engine, calls } = createEngine();
    const { q } = setup({ engine });
    await q.setEffort('tab1', 'high');
    expect(calls).toEqual([
      { subtype: 'apply_flag_settings', payload: { settings: { effortLevel: 'high' } } },
    ]);
  });

  // null means "back to the default", which on the wire is an absent key —
  // sending `effortLevel: null` would be a different instruction.
  it('maps a null level to an absent effortLevel key', async () => {
    const { engine, calls } = createEngine();
    const { q } = setup({ engine });
    await q.setEffort('tab1', null);
    const settings = (calls[0].payload as { settings: Record<string, unknown> }).settings;
    expect(settings.effortLevel).toBeUndefined();
    expect('effortLevel' in settings).toBe(true);
  });

  it('records the engine error instead of throwing', async () => {
    const { engine } = createEngine({
      control: () => {
        throw new Error('boom');
      },
    });
    const { q, meta } = setup({ engine });
    await q.setEffort('tab1', 'max');
    expect(meta()).toMatchObject({ op: 'set_effort', ok: false, level: 'max', error: 'boom' });
  });

  // The no-engine path logs rather than sending. This is the trace that was
  // missing when mid-session effort changes silently did nothing.
  it('logs a no-live-engine miss instead of failing silently', async () => {
    const { q, meta } = setup({ engine: null });
    await q.setEffort('tab1', 'high');
    expect(meta()).toMatchObject({ op: 'set_effort', ok: false, reason: 'no-live-engine', level: 'high' });
  });
});

describe('setThinking', () => {
  // Two states only: 0 disables, null means adaptive default. Non-zero
  // budgets collapse to adaptive on Opus 4.6+, so nothing else is on the wire.
  it('maps a disabled config to a zero token budget', async () => {
    const { engine, calls } = createEngine();
    const { q } = setup({ engine });
    await q.setThinking('tab1', { type: 'disabled' });
    expect(calls).toEqual([
      { subtype: 'set_max_thinking_tokens', payload: { max_thinking_tokens: 0 } },
    ]);
  });

  it('maps an absent config to a zero token budget', async () => {
    const { engine, calls } = createEngine();
    const { q } = setup({ engine });
    await q.setThinking('tab1', undefined);
    expect((calls[0].payload as { max_thinking_tokens: number }).max_thinking_tokens).toBe(0);
  });

  it('maps an enabled config to the adaptive default', async () => {
    const { engine, calls } = createEngine();
    const { q } = setup({ engine });
    await q.setThinking('tab1', { type: 'enabled', budget_tokens: 10_000 } as never);
    expect((calls[0].payload as { max_thinking_tokens: number | null }).max_thinking_tokens)
      .toBeNull();
  });

  it('swallows an engine error', async () => {
    const { engine } = createEngine({
      control: () => {
        throw new Error('x');
      },
    });
    const { q } = setup({ engine });
    await expect(q.setThinking('tab1', { type: 'disabled' })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The two paths that tell the USER something went wrong
// ---------------------------------------------------------------------------

describe('interrupt', () => {
  it('forwards to the engine', async () => {
    const interrupt = vi.fn(async () => {});
    const { engine } = createEngine({ interrupt });
    const { q, sent } = setup({ engine });
    await q.interrupt('tab1');
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  // A failed Stop is the one control error the user MUST see: the turn keeps
  // running and burning tokens, and the UI would otherwise look merely slow.
  it('notifies the renderer when the interrupt fails', async () => {
    const { engine } = createEngine({
      interrupt: async () => {
        throw new Error('pipe closed');
      },
    });
    const { q, sent } = setup({ engine });
    await q.interrupt('tab1');
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe('agent-output:tab1');
    expect(sent[0].args[0]).toMatchObject({
      type: 'system',
      subtype: 'notification',
      notification_type: 'error',
      title: 'Stop request failed',
    });
    expect(String((sent[0].args[0] as { body: string }).body)).toContain('pipe closed');
  });

  it('is a silent no-op on a TUI tab', async () => {
    const { engine } = createEngine();
    const { q, sent } = setup({ engine, mode: 'tui' });
    await q.interrupt('tab1');
    expect(sent).toEqual([]);
  });
});

describe('applyPermissions', () => {
  // The CLI loads settings files only at session start, so a rule edited
  // mid-session sits on disk unseen. apply_flag_settings shallow-merges the
  // permissions key, so the FULL effective list has to go every time.
  it('pushes the full rule list into the live session', async () => {
    const { engine, calls } = createEngine();
    const { q } = setup({ engine });
    const permissions = { allow: ['Edit(/a)'], deny: ['Bash(rm)'], ask: [] };
    await q.applyPermissions('tab1', permissions);
    expect(calls).toEqual([
      { subtype: 'apply_flag_settings', payload: { settings: { permissions } } },
    ]);
  });

  // Also user-visible on failure: the rule IS saved, so silence would leave
  // the user believing a rule is active while the session keeps prompting.
  it('warns the renderer that the rule reached disk but not the session', async () => {
    const { engine } = createEngine({
      control: () => {
        throw new Error('closed');
      },
    });
    const { q, sent } = setup({ engine });
    await q.applyPermissions('tab1', { allow: ['Edit(/a)'] });
    expect(sent[0].args[0]).toMatchObject({
      notification_type: 'warn',
      title: 'Permission rule saved on disk but not applied to live session',
    });
  });
});

// ---------------------------------------------------------------------------
// init-data readers — these use the raw handle, NOT liveEngine, so they
// answer on a TUI tab too
// ---------------------------------------------------------------------------

describe('init-data readers', () => {
  const initData = {
    account: { email: 'a@b.c' },
    commands: [{ name: 'commit' }],
    models: [{ id: 'claude-opus-5' }],
    agents: [{ name: 'Explore' }],
  };

  it('reads account, commands, models and agents off the cached init payload', async () => {
    const { engine } = createEngine({ initData });
    const { q } = setup({ engine });
    await expect(q.getAccountInfo('tab1')).resolves.toEqual({ email: 'a@b.c' });
    await expect(q.getSupportedCommands('tab1')).resolves.toEqual([{ name: 'commit' }]);
    await expect(q.getSupportedModels('tab1')).resolves.toEqual([{ id: 'claude-opus-5' }]);
    await expect(q.getSupportedAgents('tab1')).resolves.toEqual([{ name: 'Explore' }]);
  });

  it('returns empty answers before system:init has landed', async () => {
    const { engine } = createEngine({ initData: null });
    const { q } = setup({ engine });
    await expect(q.getAccountInfo('tab1')).resolves.toBeNull();
    await expect(q.getSupportedCommands('tab1')).resolves.toEqual([]);
    await expect(q.getSupportedModels('tab1')).resolves.toEqual([]);
    await expect(q.getSupportedAgents('tab1')).resolves.toEqual([]);
  });

  it('returns empty answers for a tab with no engine', async () => {
    const { q } = setup({ engine: null });
    await expect(q.getAccountInfo('tab1')).resolves.toBeNull();
    await expect(q.getSupportedCommands('tab1')).resolves.toEqual([]);
    await expect(q.getSupportedModels('tab1')).resolves.toEqual([]);
    await expect(q.getSupportedAgents('tab1')).resolves.toEqual([]);
  });

  // Deliberately NOT gated on liveEngine: the init payload is cached data,
  // and a TUI tab that was previously rich still has a usable catalog.
  it('answers on a TUI tab, unlike the control requests', async () => {
    const { engine } = createEngine({ initData });
    const { q } = setup({ engine, mode: 'tui' });
    await expect(q.getSupportedModels('tab1')).resolves.toEqual([{ id: 'claude-opus-5' }]);
  });
});

describe('getContextUsage', () => {
  it('returns the control response', async () => {
    const { engine } = createEngine({ control: () => ({ used_tokens: 42 }) });
    const { q } = setup({ engine });
    await expect(q.getContextUsage('tab1')).resolves.toEqual({ used_tokens: 42 });
  });

  it('returns null rather than throwing when the engine errors', async () => {
    const { engine } = createEngine({
      control: () => {
        throw new Error('no reply');
      },
    });
    const { q } = setup({ engine });
    await expect(q.getContextUsage('tab1')).resolves.toBeNull();
  });

  it('returns null with no live engine', async () => {
    const { q } = setup({ engine: null });
    await expect(q.getContextUsage('tab1')).resolves.toBeNull();
  });
});

describe('getMcpServerStatus', () => {
  it('returns the reported servers', async () => {
    const { engine } = createEngine({ control: () => ({ mcpServers: [{ name: 'brain' }] }) });
    const { q } = setup({ engine });
    await expect(q.getMcpServerStatus('tab1')).resolves.toEqual([{ name: 'brain' }]);
  });

  it('returns empty when the engine reports no servers', async () => {
    const { engine } = createEngine({ control: () => ({ mcpServers: [] }) });
    const { q } = setup({ engine });
    await expect(q.getMcpServerStatus('tab1')).resolves.toEqual([]);
  });

  it('returns empty when the engine is not ready', async () => {
    const { engine } = createEngine({
      control: () => {
        throw new Error('not ready');
      },
    });
    const { q } = setup({ engine });
    await expect(q.getMcpServerStatus('tab1')).resolves.toEqual([]);
  });

  // A hung mcp_status must not hold the popover open forever.
  it('gives up after the 3s race and reports empty', async () => {
    vi.useFakeTimers();
    const { engine } = createEngine({ control: () => new Promise(() => {}) });
    const { q } = setup({ engine });
    const p = q.getMcpServerStatus('tab1');
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual([]);
    vi.useRealTimers();
  });
});

describe('getPlugins', () => {
  const plugins = { plugins: [{ name: 'superpowers', path: '/p/superpowers' }] };

  // reload_plugins is side-effectful, so the result is cached per tab and
  // only refreshed when the caller explicitly asks.
  it('caches after the first call', async () => {
    const { engine, calls } = createEngine({ control: () => plugins });
    const { q } = setup({ engine });
    const first = await q.getPlugins('tab1');
    const second = await q.getPlugins('tab1');
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('re-requests when forced', async () => {
    const { engine, calls } = createEngine({ control: () => plugins });
    const { q } = setup({ engine });
    await q.getPlugins('tab1');
    await q.getPlugins('tab1', true);
    expect(calls).toHaveLength(2);
  });

  // Eviction is called by lifecycle on session stop so entries don't
  // accumulate for the life of the process.
  it('re-requests after the tab is evicted', async () => {
    const { engine, calls } = createEngine({ control: () => plugins });
    const { q } = setup({ engine });
    await q.getPlugins('tab1');
    q.evictPluginCache('tab1');
    await q.getPlugins('tab1');
    expect(calls).toHaveLength(2);
  });

  it('tolerates a response carrying no plugins array', async () => {
    const { engine } = createEngine({ control: () => ({}) });
    const { q } = setup({ engine });
    await expect(q.getPlugins('tab1')).resolves.toEqual([]);
  });

  // Both failure paths keep the last good answer rather than blanking the
  // list — a transient reload must not look like "you have no plugins".
  it('falls back to the cached list when a forced reload errors', async () => {
    let fail = false;
    const { engine } = createEngine({
      control: () => {
        if (fail) throw new Error('reload failed');
        return plugins;
      },
    });
    const { q } = setup({ engine });
    const good = await q.getPlugins('tab1');
    fail = true;
    await expect(q.getPlugins('tab1', true)).resolves.toEqual(good);
  });

  it('falls back to the cached list when a forced reload times out', async () => {
    vi.useFakeTimers();
    let hang = false;
    const { engine } = createEngine({
      control: () => (hang ? new Promise(() => {}) : plugins),
    });
    const { q } = setup({ engine });
    const good = await q.getPlugins('tab1');
    hang = true;
    const p = q.getPlugins('tab1', true);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual(good);
    vi.useRealTimers();
  });

  it('returns empty for a tab with no live engine', async () => {
    const { q } = setup({ engine: null });
    await expect(q.getPlugins('tab1')).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Optional collaborators
// ---------------------------------------------------------------------------

describe('optional deps', () => {
  it('works with no logging and no renderer wired', async () => {
    const { engine, calls } = createEngine();
    const sessions = new Map<string, SessionHandle>([['tab1', handle(engine)]]);
    const q = createQueryPassthroughs(sessions);
    await q.setModel('tab1', 'claude-opus-5');
    await q.interrupt('tab1');
    expect(calls).toHaveLength(1);
  });

  // Logging is diagnostics. A failing logger must never take down the
  // control request it was only observing.
  it('survives a logging service that throws', async () => {
    const { engine, calls } = createEngine();
    const sessions = new Map<string, SessionHandle>([['tab1', handle(engine)]]);
    const logging = {
      writeBatch: vi.fn(() => {
        throw new Error('db locked');
      }),
    } as unknown as LoggingService;
    const q = createQueryPassthroughs(sessions, null, logging);
    await expect(q.setModel('tab1', 'claude-opus-5')).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

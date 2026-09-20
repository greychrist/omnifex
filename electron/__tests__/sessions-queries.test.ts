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

function handle(engine: AgentEngine): SessionHandle {
  return {
    agent: 'claude',
    engine,
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
  engine?: AgentEngine;
  registered?: boolean;
} = {}) {
  const sessions = new Map<string, SessionHandle>();
  if (opts.registered !== false) {
    sessions.set('tab1', handle(opts.engine ?? createEngine().engine));
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
  it('treats an unknown tab as having no live engine', async () => {
    const { q, meta } = setup({ registered: false });
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

// The CLI persists a rename as a `custom-title` record and lets it outrank
// the `ai-title` it generated itself, so this request — not a write of our
// own into its transcript — is what makes a rename official. `source: 'host'`
// is the CLI's own name for "the user renamed it in the hosting app", which
// is exactly what the pencil in the status bar is.
// Naming is user-triggered: the CLI stopped auto-naming stdin-driven sessions
// in 2.1.277, and Greg does not want a model call fired on his behalf. The
// Suggest button asks for a name and writes NOTHING (`persist: false`); the
// user saves it through the ordinary rename path if they like it.
describe('suggestTitle', () => {
  it('asks the CLI for a title without persisting it and returns the suggestion', async () => {
    const { engine, calls } = createEngine({ control: () => ({ title: 'Tomato watering schedule' }) });
    const { q, meta } = setup({ engine });
    await expect(q.suggestTitle('tab1', 'How often should I water tomatoes in late summer?')).resolves.toBe('Tomato watering schedule');
    expect(calls).toEqual([
      { subtype: 'generate_session_title', payload: { description: 'How often should I water tomatoes in late summer?', persist: false } },
    ]);
    expect(meta()).toMatchObject({ op: 'generate_session_title', ok: true, title: 'Tomato watering schedule' });
  });

  it('returns null for a blank description, an unknown tab, or a CLI that answers without a title', async () => {
    const { engine, calls } = createEngine({ control: () => ({}) });
    const live = setup({ engine });
    await expect(live.q.suggestTitle('tab1', '   ')).resolves.toBeNull();
    expect(calls).toEqual([]);
    await expect(live.q.suggestTitle('tab1', 'real prompt')).resolves.toBeNull();
    const dead = setup({ registered: false });
    await expect(dead.q.suggestTitle('tab1', 'real prompt')).resolves.toBeNull();
    expect(dead.meta().reason).toBe('no-live-engine');
  });

  it('returns null when the engine rejects instead of throwing', async () => {
    const { engine } = createEngine({ control: () => { throw new Error('control channel closed'); } });
    const { q, meta } = setup({ engine });
    await expect(q.suggestTitle('tab1', 'real prompt')).resolves.toBeNull();
    expect(meta()).toMatchObject({ op: 'generate_session_title', ok: false, error: 'control channel closed' });
  });
});

describe('setTitle', () => {
  it('sends rename_session as a host rename', async () => {
    const { engine, calls } = createEngine({ control: () => ({ ok: true }) });
    const { q, meta } = setup({ engine });
    await q.setTitle('tab1', 'Rate-limit spike');
    expect(calls).toEqual([
      { subtype: 'rename_session', payload: { title: 'Rate-limit spike', source: 'host' } },
    ]);
    expect(meta()).toMatchObject({ op: 'rename_session', ok: true, title: 'Rate-limit spike' });
  });

  // Unlike its neighbours, this one reports back. A rename that quietly did
  // nothing would leave the pencil looking like it worked while the session
  // kept its old name — the silent-no-op failure this file exists to catch.
  it('reports whether the rename actually went out', async () => {
    const { engine } = createEngine({ control: () => ({ ok: true }) });
    const live = setup({ engine });
    await expect(live.q.setTitle('tab1', 'Named')).resolves.toBe(true);

    const dead = setup({ registered: false });
    await expect(dead.q.setTitle('tab1', 'Named')).resolves.toBe(false);
    expect(dead.meta().reason).toBe('no-live-engine');
  });

  it('reports false when the engine rejects instead of throwing', async () => {
    const { engine } = createEngine({
      control: () => {
        throw new Error('control channel closed');
      },
    });
    const { q, meta } = setup({ engine });
    await expect(q.setTitle('tab1', 'Named')).resolves.toBe(false);
    expect(meta()).toMatchObject({ ok: false, error: 'control channel closed' });
  });

  // The CLI treats an empty custom title as "clear the rename", which would
  // silently drop the session back to its generated name — never what the
  // pencil meant. Trim here so the intent is decided in one place.
  it('trims the title and refuses a blank one', async () => {
    const { engine, calls } = createEngine();
    const { q } = setup({ engine });
    await q.setTitle('tab1', '  Padded  ');
    expect(calls).toEqual([
      { subtype: 'rename_session', payload: { title: 'Padded', source: 'host' } },
    ]);

    const blank = setup({ engine: createEngine().engine });
    await expect(blank.q.setTitle('tab1', '   ')).resolves.toBe(false);
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
    const { q, meta } = setup({ registered: false });
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
    const { q } = setup({ registered: false });
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
    const { q } = setup({ registered: false });
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

// ---------------------------------------------------------------------------
// listPermissionRules — the read-back for applyPermissions
// ---------------------------------------------------------------------------
//
// OmniFex pushes rules INTO a live session (applyPermissions -> flag_settings)
// after reading the three settings files itself. Until CLI 2.1.269 there was
// no way to read back what the session actually ended up with, so the
// permissions panel showed a file-derived guess: `allow`/`deny` only, no
// `ask`, no policy/managed rules, and no way to see that the push landed in
// `flagSettings` as its own source rather than merging into the file sources.
//
// `list_permission_rules` is that read-back. It is READ-ONLY by contract
// ("this request never changes rules"), so these tests pin that we send no
// payload and mutate no handle state.
describe('listPermissionRules', () => {
  const state = {
    rules: [
      { behavior: 'allow', source: 'userSettings', rule: 'Bash(npm run test:*)', editability: 'persistent' },
      { behavior: 'ask', source: 'projectSettings', rule: 'Edit(/src/**)', editability: 'persistent' },
      { behavior: 'deny', source: 'policySettings', rule: 'Bash(curl:*)', editability: 'readonly' },
    ],
    workspaceDirectories: [{ path: '/proj', source: 'localSettings' }],
    originalCwd: '/proj',
    managedOnly: false,
  };

  it('sends a bare list_permission_rules request and unwraps `state`', async () => {
    const { engine, calls } = createEngine({ control: () => ({ state }) });
    const { q } = setup({ engine });
    const got = await q.listPermissionRules('tab1');
    expect(calls).toEqual([{ subtype: 'list_permission_rules', payload: undefined }]);
    expect(got).toEqual(state);
  });

  // The whole point is surfacing what the file-derived view cannot: `ask`
  // rules (permissions-io reads only allow/deny) and read-only policy rules.
  it('carries ask rules and non-file sources through', async () => {
    const { engine } = createEngine({ control: () => ({ state }) });
    const { q } = setup({ engine });
    const got = await q.listPermissionRules('tab1');
    expect(got?.rules.map((r) => r.behavior)).toEqual(['allow', 'ask', 'deny']);
    expect(got?.rules.map((r) => r.source)).toContain('policySettings');
  });

  // An older CLI answers "list_permission_rules is not available on this
  // connection". That must degrade to the file view, not blank the panel.
  it('returns null when the CLI rejects the request', async () => {
    const { engine } = createEngine({
      control: () => {
        throw new Error('list_permission_rules is not available on this connection');
      },
    });
    const { q } = setup({ engine });
    expect(await q.listPermissionRules('tab1')).toBeNull();
  });

  // A success envelope with no `state` is malformed; treat it as no answer.
  it('returns null when the response carries no state', async () => {
    const { engine } = createEngine({ control: () => ({}) });
    const { q } = setup({ engine });
    expect(await q.listPermissionRules('tab1')).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionBridge, type SessionBridge } from '../remote/bridge';
import { createSessionLog, type SessionLog } from '../remote/session-log';
import { ServerMessageSchema, type ServerMessage, type SessionScopedPush } from '../../src/protocol';
import { classifyJsonlLine } from '../../src/lib/jsonlClassifier';

interface Fixture {
  sessionId: string;
  frames: [string, unknown?][];
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'remote', 'stream-json-turn.json'), 'utf8'),
);

function openSession(log: SessionLog, sessionId: string) {
  log.open({
    sessionId,
    projectId: 'p1',
    projectPath: '/Users/greg/Repos/omnifex',
    configDir: '/Users/greg/.claude-personal',
    agent: 'claude',
    options: {},
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  });
}

describe('remote session bridge', () => {
  let root: string;
  let log: SessionLog;
  let bridge: SessionBridge;
  let published: SessionScopedPush[];
  let broadcast: ServerMessage[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omnifex-bridge-'));
    log = createSessionLog({ root });
    published = [];
    broadcast = [];
    bridge = createSessionBridge({
      log,
      classify: classifyJsonlLine,
      publish: (p) => { published.push(p); },
      broadcast: (m) => { broadcast.push(m); },
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The early-warning test the plan asks for: a captured turn goes through
   * the bridge and the emitted protocol sequence is asserted in full. When a
   * CLI release moves a shape we depend on, this is where it shows.
   */
  it('replays the captured turn into the expected push sequence', () => {
    openSession(log, FIXTURE.sessionId);
    for (const [channel, payload] of FIXTURE.frames) {
      if (payload === undefined) bridge.sendToRenderer(channel);
      else bridge.sendToRenderer(channel, payload);
    }

    const summary = published.map((p) =>
      p.type === 'event'
        ? `${p.seq}:event/${p.kind}${p.origin ? `@${p.origin}` : ''}` +
          (p.kind === 'transcript' ? `:${(p.payload as { kind: string }).kind}` : '')
        : p.type === 'permission.request'
          ? `${p.seq}:permission.request/${p.tool}#${p.permissionId}`
          : `${p.seq}:session.state/${p.sessionStatus}`,
    );

    expect(summary).toEqual([
      '1:session.state/started',
      '2:event/init',
      '3:event/transcript@engine:cli-stream-init',
      '4:event/transcript@engine:user',
      '5:event/transcript@engine:assistant',
      '6:permission.request/Bash#req-1',
      '7:event/notification',
      '8:event/transcript@engine:user',
      '9:event/transcript@tail:queue-operation',
      '10:event/transcript@engine:assistant',
      '11:event/transcript@engine:cli-stream-result',
      '12:event/stderr',
      '13:session.state/stopped',
      '14:event/complete',
    ]);

    // Two frames in the fixture are app-wide, not session-scoped, even though
    // one of them starts with `session-`. Both go out as `channel` broadcasts.
    expect(broadcast.map((m) => (m.type === 'channel' ? m.channel : m.type))).toEqual([
      'rate-limits:updated',
      'session-summary:updated',
    ]);

    // Everything emitted is valid on the wire.
    for (const p of [...published, ...broadcast]) {
      expect(ServerMessageSchema.safeParse(JSON.parse(JSON.stringify(p))).success, JSON.stringify(p)).toBe(true);
    }
  });

  it('forwards a tool_progress heartbeat as a classified transcript event', () => {
    openSession(log, 's1');
    bridge.sendToRenderer('agent-output:s1', {
      type: 'tool_progress',
      tool_use_id: 'toolu_A-heartbeat-0',
      tool_name: 'Bash',
      parent_tool_use_id: 'toolu_A',
      elapsed_time_seconds: 30,
      heartbeat: true,
    });

    expect(published).toHaveLength(1);
    const p = published[0];
    if (p.type !== 'event') throw new Error('expected a transcript event');
    expect(p.kind).toBe('transcript');
    const node = p.payload as { kind: string; anchorToolUseId?: string };
    // Classified server-side, so the anchor id is computed once and every
    // client sees the same one. It is the REAL tool id, not the synthetic
    // per-beat id the frame carries.
    expect(node.kind).toBe('tool-progress');
    expect(node.anchorToolUseId).toBe('toolu_A');
  });

  /**
   * Heartbeats go through the ordinary logged path, and that is deliberate.
   *
   * An earlier design had the bridge forward them without logging, on the
   * theory that replay bought nothing. It does not survive the code: `emit`
   * is `publish(log.append(push))` and `broadcast` takes only `channel`
   * messages, so skipping the log needs either a new unsequenced push type or
   * a stamp-without-persist method — new protocol surface to avoid one line
   * per 30 seconds per slow tool against a 5,000-entry ring. Replaying a
   * beat is also harmless: the chip refuses to paint progress for a tool
   * whose result has landed, and for one still running the replayed value is
   * simply correct.
   */
  it('logs a tool_progress frame like any other transcript row', () => {
    openSession(log, 's1');
    bridge.sendToRenderer('agent-output:s1', {
      type: 'tool_progress',
      tool_use_id: 'toolu_A-heartbeat-0',
      tool_name: 'Bash',
      parent_tool_use_id: 'toolu_A',
      elapsed_time_seconds: 30,
      heartbeat: true,
    });

    const replayed = log.replay('s1', 0);
    expect(replayed).toHaveLength(1);
    expect((replayed[0] as { payload: { kind: string } }).payload.kind).toBe('tool-progress');
  });

  it('carries the renderer\'s permission-card payload whole and lifts the addressable fields', () => {
    openSession(log, 's1');
    const payload = {
      type: 'permission_request',
      request_id: 'req-9',
      tool_name: 'Edit',
      tool_input: { file_path: '/a.ts' },
      title: 'Edit a.ts',
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits' }],
    };
    bridge.sendToRenderer('agent-output:s1', payload);

    expect(published).toHaveLength(1);
    const p = published[0];
    expect(p.type).toBe('permission.request');
    if (p.type !== 'permission.request') throw new Error('unreachable');
    expect(p).toMatchObject({
      permissionId: 'req-9',
      tool: 'Edit',
      input: { file_path: '/a.ts' },
      kind: 'tool',
      suggestions: [{ type: 'setMode', mode: 'acceptEdits' }],
      payload,
    });
    expect(bridge.pendingPermissions('s1')).toEqual(['req-9']);
  });

  it('marks Codex approvals with their kind', () => {
    openSession(log, 's1');
    bridge.sendToRenderer('agent-output:s1', {
      type: 'permission_request',
      request_id: 'c-1',
      kind: 'exec',
      agent: 'codex',
      summary: 'Run npm test',
      tool_name: 'exec_command',
      tool_input: {},
      permission_suggestions: [],
    });
    const p = published[0];
    expect(p.type === 'permission.request' && p.kind).toBe('exec');
  });

  it('clears a pending permission when told it was answered', () => {
    openSession(log, 's1');
    bridge.sendToRenderer('agent-output:s1', { type: 'permission_request', request_id: 'req-1', tool_name: 'Bash', tool_input: {} });
    bridge.sendToRenderer('agent-output:s1', { type: 'permission_request', request_id: 'req-2', tool_name: 'Bash', tool_input: {} });
    expect(bridge.pendingPermissions('s1')).toEqual(['req-1', 'req-2']);
    bridge.permissionAnswered('s1', 'req-1');
    expect(bridge.pendingPermissions('s1')).toEqual(['req-2']);
  });

  it('keeps raw output that the classifier rejects rather than dropping it', () => {
    openSession(log, 's1');
    // No `type` field: classifyJsonlLine returns null for this.
    bridge.sendToRenderer('agent-output:s1', { weird: true });
    expect(published).toHaveLength(1);
    const p = published[0];
    expect(p.type === 'event' && p.payload).toMatchObject({ kind: 'unknown', raw: { weird: true } });
  });

  it('tracks the connection axis for the summary', () => {
    openSession(log, 's1');
    expect(bridge.state('s1')).toMatchObject({ sessionStatus: 'starting' });
    bridge.sendToRenderer('session-status:s1', { sessionStatus: 'started' });
    expect(bridge.state('s1')).toEqual({ sessionStatus: 'started', turn: { status: 'idle', since: null } });
    const states = published.filter((p) => p.type === 'session.state');
    expect(states.at(-1)).toMatchObject({ sessionStatus: 'started' });
  });

  it('mirrors the session\'s turn axis into session.state, idle until told otherwise', () => {
    openSession(log, 's1');
    bridge.sendToRenderer('session-status:s1', { sessionStatus: 'started' });
    expect(bridge.state('s1')).toMatchObject({ turn: { status: 'idle', since: null } });

    bridge.sendToRenderer('session-turn:s1', { status: 'running', since: '2026-09-20T00:00:00.000Z' });
    expect(bridge.state('s1')).toMatchObject({ turn: { status: 'running', since: '2026-09-20T00:00:00.000Z' } });
    const states = published.filter((p) => p.type === 'session.state');
    expect(states.at(-1)).toMatchObject({ sessionStatus: 'started', turn: { status: 'running', since: '2026-09-20T00:00:00.000Z' } });

    // The bridge does not close turns itself — a result row is transcript,
    // and the session announces its own idle.
    bridge.sendToRenderer('agent-output:s1', { type: 'result', subtype: 'success', is_error: false, result: 'done', receivedAt: '2026-09-10T03:00:02.000Z' });
    expect(bridge.state('s1')).toMatchObject({ turn: { status: 'running' } });
    bridge.sendToRenderer('session-turn:s1', { status: 'idle', since: null });
    expect(bridge.state('s1')).toMatchObject({ turn: { status: 'idle', since: null } });
  });

  it('stamps every event with the legacy channel prefix it came from', () => {
    openSession(log, 's1');
    bridge.sendToRenderer('elicitation-request:s1', { id: 'e1', message: 'Pick one' });
    bridge.sendToRenderer('session-account-mismatch:s1', { expected: 'a@b', detected: null });
    expect(published.map((p) => (p.type === 'event' ? [p.kind, p.channel] : null))).toEqual([
      ['elicitation', 'elicitation-request'],
      ['account-mismatch', 'session-account-mismatch'],
    ]);
  });
});

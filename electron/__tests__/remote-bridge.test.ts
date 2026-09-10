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
    mode: 'rich',
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
      '12:event/control-state',
      '13:event/stderr',
      '14:session.state/stopped',
      '15:event/complete',
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

  it('tracks the connection axis and control state for the summary', () => {
    openSession(log, 's1');
    expect(bridge.state('s1')).toMatchObject({ sessionStatus: 'starting' });
    bridge.sendToRenderer('session-status:s1', { sessionStatus: 'started' });
    bridge.sendToRenderer('session-control-state:s1', { model: 'claude-opus-5', permissionMode: 'acceptEdits' });
    bridge.sendToRenderer('session-mode:s1', { mode: 'tui' });
    expect(bridge.state('s1')).toEqual({
      sessionStatus: 'started',
      mode: 'tui',
      model: 'claude-opus-5',
      permissionMode: 'acceptEdits',
    });
    // session.state pushes reflect the merged view, not just the delta.
    const states = published.filter((p) => p.type === 'session.state');
    expect(states.at(-1)).toMatchObject({ sessionStatus: 'started', mode: 'tui', model: 'claude-opus-5' });
  });

  it('tracks a running turn: opened by turnStarted, closed by the result row', () => {
    openSession(log, 's1');
    expect(bridge.inFlight('s1')).toBe(false);
    bridge.turnStarted('s1');
    expect(bridge.inFlight('s1')).toBe(true);
    // Assistant output does not close it.
    bridge.sendToRenderer('agent-output:s1', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] }, receivedAt: '2026-09-10T03:00:01.000Z' });
    expect(bridge.inFlight('s1')).toBe(true);
    // The CLI's result row does — the same turn-closer the renderer uses.
    bridge.sendToRenderer('agent-output:s1', { type: 'result', subtype: 'success', is_error: false, result: 'done', receivedAt: '2026-09-10T03:00:02.000Z' });
    expect(bridge.inFlight('s1')).toBe(false);
  });

  it('closes a running turn when the process completes or the session stops', () => {
    openSession(log, 's1');
    bridge.turnStarted('s1');
    bridge.sendToRenderer('agent-complete:s1');
    expect(bridge.inFlight('s1')).toBe(false);

    bridge.turnStarted('s1');
    bridge.sendToRenderer('session-status:s1', { sessionStatus: 'stopped' });
    expect(bridge.inFlight('s1')).toBe(false);

    bridge.turnStarted('s1');
    bridge.forget('s1');
    expect(bridge.inFlight('s1')).toBe(false);
  });

  it('routes a tab-scoped channel for a session it does not know as an app-wide broadcast', () => {
    // No open session: this is not a session frame, whatever its prefix.
    bridge.sendToRenderer('agent-output:ghost', { type: 'assistant' });
    expect(published).toEqual([]);
    expect(broadcast).toEqual([{ type: 'channel', channel: 'agent-output:ghost', payload: { type: 'assistant' } }]);
  });

  it('stamps every event with the legacy channel prefix it came from', () => {
    openSession(log, 's1');
    bridge.sendToRenderer('session-tui-data:s1', 'x1b[2J');
    bridge.sendToRenderer('elicitation-request:s1', { id: 'e1', message: 'Pick one' });
    bridge.sendToRenderer('session-account-mismatch:s1', { expected: 'a@b', detected: null });
    expect(published.map((p) => (p.type === 'event' ? [p.kind, p.channel] : null))).toEqual([
      ['tui-data', 'session-tui-data'],
      ['elicitation', 'elicitation-request'],
      ['account-mismatch', 'session-account-mismatch'],
    ]);
  });
});

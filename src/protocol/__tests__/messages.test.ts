import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  CLIENT_METHODS,
  SESSION_SCOPED_PUSHES,
  ClientMessageSchema,
  ServerMessageSchema,
  decodeClientMessage,
  decodeServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '@/protocol';

/**
 * One representative message per client method. Doubles as the round-trip
 * corpus and as the drift guard: a method added to CLIENT_METHODS without a
 * sample here fails `covers every declared method`.
 */
const CLIENT_SAMPLES: ClientMessage[] = [
  { type: 'hello', requestId: 'r1', clientId: 'c1', clientKind: 'electron', protocolVersion: PROTOCOL_VERSION },
  { type: 'project.list', requestId: 'r2' },
  { type: 'project.add', requestId: 'r3', path: '/Users/greg/Repos/omnifex' },
  { type: 'project.remove', requestId: 'r4', projectId: 'p1' },
  { type: 'session.list', requestId: 'r5' },
  { type: 'session.create', requestId: 'r6', projectId: 'p1' },
  { type: 'session.resume', requestId: 'r7', sessionId: 's1' },
  { type: 'session.kill', requestId: 'r8', sessionId: 's1' },
  { type: 'session.subscribe', requestId: 'r9', sessionId: 's1', fromSeq: 12 },
  { type: 'session.unsubscribe', requestId: 'r10', sessionId: 's1' },
  { type: 'turn.send', requestId: 'r11', sessionId: 's1', content: 'hello' },
  { type: 'turn.interrupt', requestId: 'r12', sessionId: 's1' },
  {
    type: 'permission.respond',
    requestId: 'r13',
    sessionId: 's1',
    permissionId: 'perm-1',
    decision: 'allow',
  },
  { type: 'history.get', requestId: 'r14', sessionId: 's1', limit: 100 },
  { type: 'rpc.invoke', requestId: 'r15', channel: 'list_accounts' },
];

const SERVER_SAMPLES: ServerMessage[] = [
  {
    type: 'welcome',
    protocolVersion: PROTOCOL_VERSION,
    daemonVersion: '0.4.156',
    capabilities: { tui: true, rpcInvoke: true },
  },
  { type: 'response', requestId: 'r1', ok: true, result: { projects: [] } },
  { type: 'response', requestId: 'r2', ok: false, error: { code: 'NOT_FOUND', message: 'no such session' } },
  {
    type: 'project.changed',
    projects: [
      {
        projectId: 'p1',
        path: '/Users/greg/Repos/omnifex',
        title: 'omnifex',
        accountId: 1,
        configDir: '/Users/greg/.claude-personal',
      },
    ],
  },
  {
    type: 'session.changed',
    sessions: [
      {
        sessionId: 's1',
        projectId: 'p1',
        agent: 'claude',
        mode: 'rich',
        sessionStatus: 'started',
        lastSeq: 42,
        pendingPermissions: 0,
        inFlight: false,
      },
    ],
  },
  { type: 'session.state', sessionId: 's1', seq: 43, sessionStatus: 'started', mode: 'rich', agent: 'claude' },
  { type: 'event', sessionId: 's1', seq: 44, kind: 'transcript', payload: { kind: 'assistant' } },
  {
    type: 'permission.request',
    sessionId: 's1',
    seq: 45,
    permissionId: 'perm-1',
    tool: 'Bash',
    input: { command: 'ls' },
  },
  { type: 'error', code: 'MALFORMED_MESSAGE', message: 'not a protocol message' },
  { type: 'channel', channel: 'rate-limits:updated', payload: { accountName: 'Personal' } },
  { type: 'event', sessionId: 's1', seq: 46, kind: 'transcript', origin: 'tail', payload: { kind: 'queue-operation' } },
];

/** JSON is the wire format; a round trip must survive it. */
function wire<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('protocol messages', () => {
  it('pins the protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  describe('client → daemon', () => {
    it('covers every declared method with a sample', () => {
      expect(CLIENT_SAMPLES.map((m) => m.type).sort()).toEqual([...CLIENT_METHODS].sort());
    });

    it('round-trips every sample through JSON unchanged', () => {
      for (const sample of CLIENT_SAMPLES) {
        expect(ClientMessageSchema.parse(wire(sample))).toEqual(sample);
      }
    });

    it('requires a requestId on every request', () => {
      for (const sample of CLIENT_SAMPLES) {
        const { requestId: _dropped, ...withoutId } = sample as ClientMessage & { requestId: string };
        expect(ClientMessageSchema.safeParse(withoutId).success).toBe(false);
      }
    });

    it('rejects an unknown message type', () => {
      expect(ClientMessageSchema.safeParse({ type: 'session.explode', requestId: 'r' }).success).toBe(false);
    });
  });

  describe('daemon → client', () => {
    it('round-trips every sample through JSON unchanged', () => {
      for (const sample of SERVER_SAMPLES) {
        expect(ServerMessageSchema.parse(wire(sample))).toEqual(sample);
      }
    });

    it('names every session-scoped push that carries a seq', () => {
      // These three share ONE per-session sequence space so that a
      // `session.subscribe { fromSeq }` replay covers state transitions and
      // open permission requests, not just transcript events. A push added to
      // the seq space without being listed here would be silently dropped
      // from replay.
      expect([...SESSION_SCOPED_PUSHES].sort()).toEqual(['event', 'permission.request', 'session.state']);
      for (const sample of SERVER_SAMPLES) {
        if (!(SESSION_SCOPED_PUSHES as readonly string[]).includes(sample.type)) continue;
        expect(sample).toHaveProperty('sessionId');
        expect(sample).toHaveProperty('seq');
      }
    });

    it('rejects a seq that is not a positive integer', () => {
      const base = { type: 'event', sessionId: 's1', kind: 'transcript', payload: {} };
      for (const seq of [0, -1, 1.5]) {
        expect(ServerMessageSchema.safeParse({ ...base, seq }).success).toBe(false);
      }
      expect(ServerMessageSchema.safeParse({ ...base, seq: 1 }).success).toBe(true);
    });

    it('keeps ok:true and ok:false responses distinguishable', () => {
      const okRes = ServerMessageSchema.parse({ type: 'response', requestId: 'r', ok: true, result: 7 });
      expect(okRes).toMatchObject({ ok: true, result: 7 });

      const errRes = ServerMessageSchema.safeParse({
        type: 'response',
        requestId: 'r',
        ok: false,
        // An error response with no error body is malformed: the client would
        // reject the promise with nothing to show.
      });
      expect(errRes.success).toBe(false);
    });
  });

  describe('forward compatibility', () => {
    it('preserves unknown fields on a client message rather than stripping them', () => {
      const parsed = ClientMessageSchema.parse({
        type: 'session.create',
        requestId: 'r',
        projectId: 'p1',
        futureField: 'from a newer client',
      });
      expect(parsed).toHaveProperty('futureField', 'from a newer client');
    });

    it('preserves unknown fields on a server message', () => {
      const parsed = ServerMessageSchema.parse({
        type: 'session.state',
        sessionId: 's1',
        seq: 1,
        sessionStatus: 'started',
        mode: 'rich',
        agent: 'claude',
        futureAxis: 'from a newer daemon',
      });
      expect(parsed).toHaveProperty('futureAxis', 'from a newer daemon');
    });

    it('does not accept an unknown sessionStatus — the axis is closed', () => {
      // Unknown *fields* are tolerated; unknown *values* on a modelled axis are
      // not. docs/session-lifecycle.md owns this enum, and a client that
      // silently accepted 'running' here would resurrect the conflated-axis bug.
      expect(
        ServerMessageSchema.safeParse({
          type: 'session.state',
          sessionId: 's1',
          seq: 1,
          sessionStatus: 'running',
          mode: 'rich',
          agent: 'claude',
        }).success,
      ).toBe(false);
    });
  });

  describe('decode helpers', () => {
    it('returns the typed message on success', () => {
      const res = decodeClientMessage({ type: 'session.list', requestId: 'r' });
      expect(res).toEqual({ ok: true, message: { type: 'session.list', requestId: 'r' } });
    });

    it('returns a MALFORMED_MESSAGE error instead of throwing', () => {
      const res = decodeClientMessage({ nonsense: true });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.error.code).toBe('MALFORMED_MESSAGE');
      expect(res.error.message).toBeTruthy();
    });

    it('decodes server messages with the same contract', () => {
      expect(decodeServerMessage({ type: 'welcome', protocolVersion: 1, daemonVersion: '0.0.0' }).ok).toBe(true);
      expect(decodeServerMessage(42).ok).toBe(false);
    });
  });

  describe('permission decisions', () => {
    it('carries the CLI rule shape for allow-and-remember', () => {
      const msg = ClientMessageSchema.parse({
        type: 'permission.respond',
        requestId: 'r',
        sessionId: 's1',
        permissionId: 'perm-1',
        decision: 'allow',
        updatedInput: { command: 'ls -la' },
        remember: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
            behavior: 'allow',
            destination: 'projectSettings',
          },
        ],
      });
      expect(msg).toMatchObject({ decision: 'allow' });
    });

    it('tolerates a suggestion entry the CLI invented after this build', () => {
      // The CLI ships setMode / addDirectories entries alongside addRules and
      // adds new kinds without warning; dropping the whole response over one
      // unrecognised entry would break Allow on a working session.
      const res = ClientMessageSchema.safeParse({
        type: 'permission.respond',
        requestId: 'r',
        sessionId: 's1',
        permissionId: 'perm-1',
        decision: 'allow',
        remember: [{ type: 'setMode', mode: 'acceptEdits' }],
      });
      expect(res.success).toBe(true);
    });

    it('rejects a decision that is neither allow nor deny', () => {
      expect(
        ClientMessageSchema.safeParse({
          type: 'permission.respond',
          requestId: 'r',
          sessionId: 's1',
          permissionId: 'perm-1',
          decision: 'maybe',
        }).success,
      ).toBe(false);
    });
  });

  describe('turn.send', () => {
    it('accepts plain text or structured content blocks', () => {
      expect(ClientMessageSchema.safeParse({ type: 'turn.send', requestId: 'r', sessionId: 's', content: 'hi' }).success).toBe(true);
      expect(
        ClientMessageSchema.safeParse({
          type: 'turn.send',
          requestId: 'r',
          sessionId: 's',
          content: [{ type: 'text', text: 'hi' }],
        }).success,
      ).toBe(true);
    });

    it('carries attachments as bytes, not as local paths', () => {
      // A web client has no filesystem the daemon can read. Modelling
      // attachments as a path would work on the laptop and fail on the iPad.
      const msg = ClientMessageSchema.parse({
        type: 'turn.send',
        requestId: 'r',
        sessionId: 's',
        content: 'look at this',
        attachments: [{ name: 'shot.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }],
      });
      expect(msg).toMatchObject({ attachments: [{ name: 'shot.png' }] });

      expect(
        ClientMessageSchema.safeParse({
          type: 'turn.send',
          requestId: 'r',
          sessionId: 's',
          content: 'x',
          attachments: [{ name: 'shot.png', path: '/tmp/shot.png' }],
        }).success,
      ).toBe(false);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPushService, pushPayloadFor, type PushSendResult, type PushSubscriptionRecord } from '../remote/push';

const sub = (n: number): Omit<PushSubscriptionRecord, 'addedAt'> => ({
  endpoint: `https://push.example/${n}`,
  keys: { p256dh: `p${n}`, auth: `a${n}` },
  label: `device ${n}`,
});

describe('push service', () => {
  let dir: string;
  let file: string;
  let sent: Array<{ endpoint: string; title: string }>;
  let results: Record<string, PushSendResult>;

  const make = () =>
    createPushService({
      file,
      generateVapidKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }),
      send: async (s, p) => {
        sent.push({ endpoint: s.endpoint, title: p.title });
        return results[s.endpoint] ?? { ok: true };
      },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-push-'));
    file = join(dir, 'push.json');
    sent = [];
    results = {};
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('generates the VAPID pair once, persists it with owner-only permissions, and reuses it', () => {
    const a = make();
    expect(a.publicKey()).toBe('PUB');
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    const gen = vi.fn(() => ({ publicKey: 'NEW', privateKey: 'NEW' }));
    const b = createPushService({ file, generateVapidKeys: gen, send: async () => ({ ok: true }) });
    expect(b.publicKey()).toBe('PUB');
    expect(gen).not.toHaveBeenCalled();
  });

  it('adds subscriptions idempotently and removes by endpoint', () => {
    const svc = make();
    svc.subscribe(sub(1));
    svc.subscribe(sub(1));
    svc.subscribe(sub(2));
    expect(svc.list().map((s) => s.endpoint)).toEqual(['https://push.example/1', 'https://push.example/2']);
    expect(svc.unsubscribe('https://push.example/1')).toBe(true);
    expect(svc.unsubscribe('https://push.example/1')).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).subscriptions).toHaveLength(1);
  });

  it('fans out to every subscription and drops the ones the push service says are gone', async () => {
    const svc = make();
    svc.subscribe(sub(1));
    svc.subscribe(sub(2));
    svc.subscribe(sub(3));
    results['https://push.example/2'] = { ok: false, statusCode: 410 };
    results['https://push.example/3'] = { ok: false, statusCode: 500 };
    const r = await svc.notify({ title: 't', body: 'b', url: '/', tag: 'x' });
    expect(r).toEqual({ sent: 1, dropped: 1 });
    expect(sent).toHaveLength(3);
    // 410 dropped; 500 kept (transient).
    expect(svc.list().map((s) => s.endpoint)).toEqual(['https://push.example/1', 'https://push.example/3']);
  });

  it('is a no-op with no subscriptions', async () => {
    expect(await make().notify({ title: 't', body: 'b', url: '/', tag: 'x' })).toEqual({ sent: 0, dropped: 0 });
    expect(sent).toEqual([]);
  });
});

describe('push triggers', () => {
  const ctx = (watched: boolean) => ({ watched: () => watched, sessionTitle: () => 'omnifex' });

  it('pushes a permission request only when nobody is watching the session', () => {
    const push = {
      type: 'permission.request' as const,
      sessionId: 's1',
      seq: 5,
      permissionId: 'p',
      tool: 'Bash',
      input: { command: 'rm -rf build' },
    };
    expect(pushPayloadFor(push, ctx(true))).toBeNull();
    expect(pushPayloadFor(push, ctx(false))).toEqual({
      title: 'omnifex needs permission',
      body: 'Bash: rm -rf build',
      url: '/#session=s1',
      tag: 'perm-s1',
    });
  });

  it('pushes the end of a turn with the reply text, flagging errors', () => {
    const result = (raw: Record<string, unknown>) => ({
      type: 'event' as const,
      sessionId: 's1',
      seq: 9,
      kind: 'transcript' as const,
      payload: { kind: 'cli-stream-result', raw },
    });
    expect(pushPayloadFor(result({ result: 'Done: three files changed.' }), ctx(false))).toMatchObject({
      title: 'omnifex finished',
      body: 'Done: three files changed.',
      tag: 'turn-s1',
    });
    expect(pushPayloadFor(result({ is_error: true, result: '' }), ctx(false))).toMatchObject({
      title: 'omnifex hit an error',
      body: 'Turn complete',
    });
  });

  it('ignores ordinary transcript rows and state changes', () => {
    expect(
      pushPayloadFor({ type: 'event', sessionId: 's1', seq: 1, kind: 'transcript', payload: { kind: 'assistant' } }, ctx(false)),
    ).toBeNull();
    expect(
      pushPayloadFor({ type: 'session.state', sessionId: 's1', seq: 2, sessionStatus: 'started', mode: 'rich', agent: 'claude' }, ctx(false)),
    ).toBeNull();
  });
});

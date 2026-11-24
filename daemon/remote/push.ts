// Never push while a client is subscribed to that session. The VAPID pair is never rotated automatically:
// rotating it invalidates every subscription.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { SessionScopedPush } from '../../src/protocol';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label?: string;
  addedAt: string;
}

export interface PushStoreFile {
  vapid: { publicKey: string; privateKey: string; subject: string } | null;
  subscriptions: PushSubscriptionRecord[];
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface PushSendResult {
  ok: boolean;
  statusCode?: number;
}

export type PushSender = (sub: PushSubscriptionRecord, payload: PushPayload) => Promise<PushSendResult>;

export interface PushServiceDeps {
  file: string;
  generateVapidKeys: () => { publicKey: string; privateKey: string };
  send: PushSender;
  subject?: string;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface PushService {
  publicKey(): string;
  list(): PushSubscriptionRecord[];
  subscribe(sub: Omit<PushSubscriptionRecord, 'addedAt'>): PushSubscriptionRecord;
  unsubscribe(endpoint: string): boolean;
  notify(payload: PushPayload): Promise<{ sent: number; dropped: number }>;
}

export function createPushService(deps: PushServiceDeps): PushService {
  const log = deps.log ?? (() => {});
  let state: PushStoreFile = load();

  function load(): PushStoreFile {
    try {
      const parsed = JSON.parse(readFileSync(deps.file, 'utf8')) as Partial<PushStoreFile>;
      return {
        vapid: parsed.vapid ?? null,
        subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
      };
    } catch {
      return { vapid: null, subscriptions: [] };
    }
  }

  function save(): void {
    mkdirSync(dirname(deps.file), { recursive: true });
    writeFileSync(deps.file, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  function ensureVapid(): NonNullable<PushStoreFile['vapid']> {
    let vapid = state.vapid;
    if (!vapid) {
      const keys = deps.generateVapidKeys();
      vapid = { ...keys, subject: deps.subject ?? 'mailto:omnifex@localhost' };
      state = { ...state, vapid };
      save();
      log('generated VAPID key pair', { file: deps.file });
    }
    return vapid;
  }

  return {
    publicKey: () => ensureVapid().publicKey,
    list: () => [...state.subscriptions],

    subscribe(sub) {
      ensureVapid();
      const existing = state.subscriptions.find((s) => s.endpoint === sub.endpoint);
      if (existing) return existing;
      const record: PushSubscriptionRecord = { ...sub, addedAt: new Date().toISOString() };
      state = { ...state, subscriptions: [...state.subscriptions, record] };
      save();
      log('push subscription added', { count: state.subscriptions.length });
      return record;
    },

    unsubscribe(endpoint) {
      const before = state.subscriptions.length;
      state = { ...state, subscriptions: state.subscriptions.filter((s) => s.endpoint !== endpoint) };
      if (state.subscriptions.length === before) return false;
      save();
      return true;
    },

    async notify(payload) {
      if (state.subscriptions.length === 0) return { sent: 0, dropped: 0 };
      let sent = 0;
      const dead: string[] = [];
      await Promise.all(
        state.subscriptions.map(async (sub) => {
          try {
            const r = await deps.send(sub, payload);
            if (r.ok) sent += 1;
            else if (r.statusCode === 404 || r.statusCode === 410) dead.push(sub.endpoint);
            else log('push send failed', { endpoint: sub.endpoint.slice(0, 40), statusCode: r.statusCode });
          } catch (err) {
            log('push send threw', { endpoint: sub.endpoint.slice(0, 40), error: String(err) });
          }
        }),
      );
      if (dead.length) {
        state = { ...state, subscriptions: state.subscriptions.filter((s) => !dead.includes(s.endpoint)) };
        save();
      }
      return { sent, dropped: dead.length };
    },
  };
}

export interface PushTriggerContext {
  watched: (sessionId: string) => boolean;
  sessionTitle: (sessionId: string) => string;
}

export function pushPayloadFor(push: SessionScopedPush, ctx: PushTriggerContext): PushPayload | null {
  if (ctx.watched(push.sessionId)) return null;
  const title = ctx.sessionTitle(push.sessionId);
  const url = `/#session=${encodeURIComponent(push.sessionId)}`;

  if (push.type === 'permission.request') {
    const input = push.input as Record<string, unknown>;
    const detail =
      typeof input.command === 'string' ? input.command
      : typeof input.file_path === 'string' ? input.file_path
      : '';
    return {
      title: `${title} needs permission`,
      body: detail ? `${push.tool}: ${detail}`.slice(0, 140) : push.tool,
      url,
      tag: `perm-${push.sessionId}`,
    };
  }

  if (push.type === 'event' && push.kind === 'transcript') {
    const node = push.payload as { kind?: string; raw?: { result?: unknown; is_error?: boolean } } | null;
    if (node?.kind !== 'cli-stream-result') return null;
    const text = typeof node.raw?.result === 'string' ? node.raw.result.trim() : '';
    return {
      title: node.raw?.is_error ? `${title} hit an error` : `${title} finished`,
      body: (text || 'Turn complete').slice(0, 140),
      url,
      tag: `turn-${push.sessionId}`,
    };
  }

  return null;
}

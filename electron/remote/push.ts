/**
 * Web Push from the daemon to the Home Screen web app.
 *
 * Two triggers, both about "you are not looking and something needs you":
 * a permission request, and a turn finishing. Neither fires while a client
 * is subscribed to the session — if a screen is showing the transcript, the
 * transcript is the notification. The check is per session, not per daemon:
 * a laptop watching session A does not silence the iPad about session B.
 *
 * Subscriptions and the VAPID key pair live in `~/.omnifex/push.json`. The
 * key pair is generated once and never rotated automatically: rotating it
 * invalidates every subscription, which is a decision, not a side effect.
 *
 * Sending is injected (`web-push`'s `sendNotification` in production) so the
 * store and the trigger logic are testable without a network.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { SessionScopedPush } from '../../src/protocol';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Free text from the client (user agent), for the list in Settings. */
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
  /** Deep link the service worker opens on tap. */
  url: string;
  /** Collapses repeated notifications for one session. */
  tag: string;
}

export interface PushSendResult {
  ok: boolean;
  /** 404/410 mean the subscription is dead and should be dropped. */
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
  /** Fan out; drops subscriptions the push service reports gone. */
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
    if (!state.vapid) {
      const keys = deps.generateVapidKeys();
      state = { ...state, vapid: { ...keys, subject: deps.subject ?? 'mailto:omnifex@localhost' } };
      save();
      log('generated VAPID key pair', { file: deps.file });
    }
    return state.vapid!;
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

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export interface PushTriggerContext {
  /** True when at least one client is subscribed to the session right now. */
  watched: (sessionId: string) => boolean;
  /** For the notification title. */
  sessionTitle: (sessionId: string) => string;
}

/**
 * The payload a session push deserves, or null.
 *
 * - `permission.request` → always worth a tap when nobody is watching.
 * - a `cli-stream-result` transcript event → the turn is over.
 * Everything else is transcript noise.
 */
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

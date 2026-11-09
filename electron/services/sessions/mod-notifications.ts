// Sessions module — mods' OS notifications (`$.ui.notify`, CLI 2.1.321)
//
// The CLI hands a mod's notification to its host as `system/ui_notify` (and
// takes one back with `ui_notify_cancel`) only when the host sets
// CLAUDE_CODE_NOTIFICATIONS_HOST, which claude-cli-engine.ts does. Without
// it the mod hears "no_surface". The contract, from the CLI's own schema:
//
//  - raise it under the plugin's name, after the host's own word that a mod
//    sent it, so neither the name nor the title passes for the app's own;
//  - same `source` + `key` replaces the last, shown or waiting; no key means
//    each frame is its own notification;
//  - `delay_ms` / `at` (at most 7 days): the host holds it, so it fires with
//    the session out of reach. The Mac app books it with the notification
//    centre, which fires it even after OmniFex quits;
//  - `until_back`: throw it away if the person returns first. "Returns" here
//    is the user sending the session a message — the daemon's evidence;
//  - a cancel without `key` (the engine unloading the plugin) drops what that
//    source still has waiting in this session.
//
// Ids are derived, not stored, for keyed notices, so a cancel still reaches a
// notification booked before a daemon restart. Only the "still waiting"
// bookkeeping (keyless cancel, until_back) is memory, and losing it costs at
// most a notification that should have been withdrawn.

export const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

export interface ModNotice {
  /** Notification-centre identifier: a later notice with the same id replaces it. */
  id: string;
  title: string;
  subtitle: string;
  body: string;
  /** Epoch ms to raise it at; null raises it now. */
  deliverAt: number | null;
}

export interface ModNoticeTracker {
  notify(frame: Record<string, unknown>): ModNotice | null;
  /** Ids to take back for a `ui_notify_cancel` frame. */
  cancel(frame: Record<string, unknown>): string[];
  /** The person returned to the session: ids of waiting `until_back` notices. */
  back(): string[];
}

interface Waiting {
  sessionId: string;
  source: string;
  deliverAt: number;
  untilBack: boolean;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The registry name is not cleaned by the CLI ("a host must scrub it"). */
function scrub(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').slice(0, 60);
}

function keyedId(sessionId: string, source: string, key: string): string {
  return `mod:${sessionId}:${source}:${key}`;
}

export function createModNoticeTracker(now: () => number = Date.now): ModNoticeTracker {
  const waiting = new Map<string, Waiting>();

  function prune(t: number): void {
    for (const [id, w] of waiting) if (w.deliverAt <= t) waiting.delete(id);
  }

  return {
    notify(frame) {
      const sessionId = str(frame.session_id);
      const source = str(frame.source);
      const body = str(frame.text);
      if (!sessionId || !source || !body) return null;
      const plugin = scrub(str(frame.plugin) ?? source);
      const key = str(frame.key);
      const id = key ? keyedId(sessionId, source, key) : `mod:${sessionId}:${str(frame.uuid) ?? `${now()}`}`;

      const t = now();
      prune(t);
      const delay = num(frame.delay_ms);
      const at = num(frame.at);
      const target = delay !== null ? t + delay : at;
      const deliverAt = target !== null && target > t ? Math.min(target, t + MAX_DELAY_MS) : null;

      waiting.delete(id);
      if (deliverAt !== null) {
        waiting.set(id, { sessionId, source, deliverAt, untilBack: frame.until_back === true });
      }

      return {
        id,
        title: str(frame.title) ?? plugin,
        subtitle: `From mod “${plugin}”${frame.rewritten === true ? ' · changed by another mod' : ''}`,
        body,
        deliverAt,
      };
    },

    cancel(frame) {
      const sessionId = str(frame.session_id);
      const source = str(frame.source);
      if (!sessionId || !source) return [];
      const key = str(frame.key);
      if (key) {
        const id = keyedId(sessionId, source, key);
        waiting.delete(id);
        return [id];
      }
      prune(now());
      const ids: string[] = [];
      for (const [id, w] of waiting) {
        if (w.sessionId === sessionId && w.source === source) ids.push(id);
      }
      for (const id of ids) waiting.delete(id);
      return ids;
    },

    back() {
      prune(now());
      const ids: string[] = [];
      for (const [id, w] of waiting) if (w.untilBack) ids.push(id);
      for (const id of ids) waiting.delete(id);
      return ids;
    },
  };
}

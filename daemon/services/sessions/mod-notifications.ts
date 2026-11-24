// Raise under the plugin's name after the host's word that a mod sent it, so neither passes for the app's own.
// Ids are derived, not stored, so a cancel still reaches a notification booked before a daemon restart.

export const MAX_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

export interface ModNotice {
  id: string;
  title: string;
  subtitle: string;
  body: string;
  deliverAt: number | null;
}

export interface ModNoticeTracker {
  notify(frame: Record<string, unknown>): ModNotice | null;
  cancel(frame: Record<string, unknown>): string[];
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

// The CLI does not clean the registry name; the host must scrub it.
function scrub(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 60);
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

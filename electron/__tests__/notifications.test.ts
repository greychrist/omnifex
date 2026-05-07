import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createNotificationsService,
  type NotificationsDeps,
} from '../services/notifications';

type NotifEvent = 'close' | 'click';

interface FakeNotification {
  options: unknown;
  shown: boolean;
  closed: boolean;
  show: () => void;
  close: () => void;
  on: (event: NotifEvent, cb: () => void) => FakeNotification;
  trigger: (event: NotifEvent) => void;
}

function makeFakeNotification(options: unknown): FakeNotification {
  const handlers: Record<NotifEvent, Array<() => void>> = { close: [], click: [] };
  const fake: FakeNotification = {
    options,
    shown: false,
    closed: false,
    show() {
      fake.shown = true;
    },
    close() {
      if (fake.closed) return;
      fake.closed = true;
      handlers.close.forEach((cb) => cb());
    },
    on(event, cb) {
      handlers[event].push(cb);
      return fake;
    },
    trigger(event) {
      handlers[event].forEach((cb) => cb());
    },
  };
  return fake;
}

interface Harness {
  service: ReturnType<typeof createNotificationsService>;
  created: FakeNotification[];
  playSound: ReturnType<typeof vi.fn>;
  focusWindow: ReturnType<typeof vi.fn>;
  onNotificationClick: ReturnType<typeof vi.fn>;
  setFocused: (focused: boolean) => void;
  setSupported: (supported: boolean) => void;
}

function makeHarness(): Harness {
  const created: FakeNotification[] = [];
  let focused = false;
  let supported = true;
  const playSound = vi.fn();
  const focusWindow = vi.fn();
  const onNotificationClick = vi.fn();

  const deps: NotificationsDeps = {
    isSupported: () => supported,
    isWindowFocused: () => focused,
    focusWindow,
    onNotificationClick,
    playSound,
    getSoundPath: (isError: boolean) => (isError ? '/error.aiff' : '/success.aiff'),
    createNotification: (opts) => {
      const n = makeFakeNotification(opts);
      created.push(n);
      return n;
    },
  };

  return {
    service: createNotificationsService(deps),
    created,
    playSound,
    focusWindow,
    onNotificationClick,
    setFocused: (v: boolean) => {
      focused = v;
    },
    setSupported: (v: boolean) => {
      supported = v;
    },
  };
}

describe('notifications service', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  describe('show', () => {
    it('does nothing when notifications are not supported', () => {
      h.setSupported(false);
      h.service.show('T', 'B', false);
      expect(h.created).toHaveLength(0);
      expect(h.playSound).not.toHaveBeenCalled();
    });

    it('plays sound only when window is focused, skipping notification', () => {
      h.setFocused(true);
      h.service.show('T', 'B', false);
      expect(h.created).toHaveLength(0);
      expect(h.playSound).toHaveBeenCalledWith('/success.aiff');
    });

    it('plays error sound when focused and isError=true', () => {
      h.setFocused(true);
      h.service.show('T', 'B', true);
      expect(h.playSound).toHaveBeenCalledWith('/error.aiff');
    });

    it('posts a macOS notification when window is not focused', () => {
      h.service.show('Task Done', 'All good', false);
      expect(h.created).toHaveLength(1);
      const n = h.created[0];
      expect(n.shown).toBe(true);
      expect(n.options).toMatchObject({
        title: 'Task Done',
        body: 'All good',
        subtitle: 'Task Complete',
        sound: 'greychrist_success',
      });
    });

    it('uses error subtitle and sound on failure', () => {
      h.service.show('Task Failed', 'bad', true);
      expect(h.created[0].options).toMatchObject({
        subtitle: 'Task Failed',
        sound: 'Basso',
      });
    });

    it('honors a custom subtitle override', () => {
      h.service.show('OmniFex', 'Pick a side?', false, { tabId: 't1' }, { subtitle: 'Question' });
      expect(h.created[0].options).toMatchObject({
        title: 'OmniFex',
        body: 'Pick a side?',
        subtitle: 'Question',
      });
    });

    it('focuses the window when a notification is clicked', () => {
      h.service.show('T', 'B', false);
      h.created[0].trigger('click');
      expect(h.focusWindow).toHaveBeenCalled();
    });

    it('forwards the click payload to onNotificationClick', () => {
      h.service.show('T', 'B', false, { tabId: 'tab-123' });
      h.created[0].trigger('click');
      expect(h.onNotificationClick).toHaveBeenCalledWith({ tabId: 'tab-123' });
    });

    it('passes an empty payload when show() was called without one', () => {
      h.service.show('T', 'B', false);
      h.created[0].trigger('click');
      expect(h.onNotificationClick).toHaveBeenCalledWith({});
    });

    it('does not crash when onNotificationClick is not provided', () => {
      // Constructing a minimal alternative service without the optional dep.
      const created: FakeNotification[] = [];
      const svc = createNotificationsService({
        isSupported: () => true,
        isWindowFocused: () => false,
        focusWindow: vi.fn(),
        playSound: vi.fn(),
        getSoundPath: () => '/s.aiff',
        createNotification: (opts) => {
          const n = makeFakeNotification(opts);
          created.push(n);
          return n;
        },
      });
      svc.show('T', 'B', false, { tabId: 'x' });
      expect(() => created[0].trigger('click')).not.toThrow();
    });
  });

  describe('dismissAll', () => {
    it('closes all active notifications', () => {
      h.service.show('A', 'a', false);
      h.service.show('B', 'b', false);
      expect(h.created.every((n) => !n.closed)).toBe(true);

      h.service.dismissAll();

      expect(h.created.every((n) => n.closed)).toBe(true);
    });

    it('is safe to call with no active notifications', () => {
      expect(() => h.service.dismissAll()).not.toThrow();
    });

    it('clears tracking so stale entries are not re-closed', () => {
      h.service.show('A', 'a', false);
      h.service.dismissAll();

      const firstClosed = h.created[0].closed;

      h.service.show('B', 'b', false);
      h.service.dismissAll();

      expect(firstClosed).toBe(true);
      expect(h.created[1].closed).toBe(true);
    });

    it('removes a notification from tracking after its close event fires', () => {
      h.service.show('A', 'a', false);
      const n = h.created[0];
      n.trigger('close');

      const closeSpy = vi.spyOn(n, 'close');
      h.service.dismissAll();
      expect(closeSpy).not.toHaveBeenCalled();
    });
  });
});

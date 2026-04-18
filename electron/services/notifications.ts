import type { NotificationConstructorOptions } from 'electron';

export interface NotificationLike {
  show(): void;
  close(): void;
  on(event: 'close' | 'click', cb: () => void): this;
}

export interface NotificationsDeps {
  createNotification: (opts: NotificationConstructorOptions) => NotificationLike;
  isSupported: () => boolean;
  playSound: (path: string) => void;
  getSoundPath: (isError: boolean) => string;
  isWindowFocused: () => boolean;
  focusWindow: () => void;
}

export interface NotificationsService {
  show(title: string, body: string, isError: boolean): void;
  dismissAll(): void;
}

export function createNotificationsService(deps: NotificationsDeps): NotificationsService {
  const active = new Set<NotificationLike>();

  return {
    show(title, body, isError) {
      if (!deps.isSupported()) return;

      if (deps.isWindowFocused()) {
        deps.playSound(deps.getSoundPath(isError));
        return;
      }

      const notif = deps.createNotification({
        title,
        subtitle: isError ? 'Task Failed' : 'Task Complete',
        body,
        silent: false,
        sound: isError ? 'Basso' : 'greychrist_success',
      });

      active.add(notif);
      notif.on('close', () => {
        active.delete(notif);
      });
      notif.on('click', () => {
        active.delete(notif);
        deps.focusWindow();
      });
      notif.show();
    },

    dismissAll() {
      const snapshot = Array.from(active);
      active.clear();
      for (const n of snapshot) {
        try {
          n.close();
        } catch {
          // best-effort; already-closed notifications may throw on some platforms
        }
      }
    },
  };
}

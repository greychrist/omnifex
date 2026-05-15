import type { NotificationConstructorOptions } from 'electron';

export interface NotificationLike {
  show(): void;
  close(): void;
  on(event: 'close' | 'click', cb: () => void): this;
}

export interface NotificationClickPayload {
  tabId?: string;
}

export interface NotificationSoundResolution {
  /** Absolute file path to feed `afplay` when the window is focused. `null` skips playback. */
  afplayPath: string | null;
  /** Value for macOS `Notification.sound`. `null` makes the notification silent. */
  nativeName: string | null;
}

export interface NotificationsDeps {
  createNotification: (opts: NotificationConstructorOptions) => NotificationLike;
  isSupported: () => boolean;
  playSound: (path: string) => void;
  /**
   * Resolves the user's currently-configured sound for the given event class.
   * Called once per `show()` so picker changes take effect immediately
   * without restarting the service.
   */
  resolveSound: (isError: boolean) => NotificationSoundResolution;
  isWindowFocused: () => boolean;
  focusWindow: () => void;
  onNotificationClick?: (payload: NotificationClickPayload) => void;
}

export interface NotificationShowOptions {
  /**
   * Override the default "Task Complete" / "Task Failed" subtitle. Used by
   * the permission flow to render "Question" for AskUserQuestion prompts so
   * the OS notification reads as a question instead of a finished task.
   */
  subtitle?: string;
}

export interface NotificationsService {
  show(
    title: string,
    body: string,
    isError: boolean,
    payload?: NotificationClickPayload,
    options?: NotificationShowOptions,
  ): void;
  dismissAll(): void;
}

export function createNotificationsService(deps: NotificationsDeps): NotificationsService {
  const active = new Set<NotificationLike>();

  return {
    show(title, body, isError, payload, options) {
      if (!deps.isSupported()) return;

      const sound = deps.resolveSound(isError);

      if (deps.isWindowFocused()) {
        if (sound.afplayPath) deps.playSound(sound.afplayPath);
        return;
      }

      const notif = deps.createNotification({
        title,
        subtitle: options?.subtitle ?? (isError ? 'Task Failed' : 'Task Complete'),
        body,
        silent: sound.nativeName === null,
        ...(sound.nativeName ? { sound: sound.nativeName } : {}),
      });

      active.add(notif);
      notif.on('close', () => {
        active.delete(notif);
      });
      notif.on('click', () => {
        active.delete(notif);
        deps.focusWindow();
        deps.onNotificationClick?.(payload ?? {});
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

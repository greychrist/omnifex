/**
 * Main-process resolver for notification sound IDs.
 *
 * IDs match `src/lib/notificationSounds.ts` — keep the two files in sync.
 * Each ID maps to:
 *   - `afplayPath`: the absolute file path to feed `afplay` when the window
 *     is focused (or `null` when the user picked "no sound").
 *   - `nativeName`: the value to set on macOS `Notification.sound`. For
 *     system sounds this is the bare name like "Glass"; for the bundled
 *     OmniFex chime it's `greychrist_success` (resolved by macOS against
 *     the app's bundled aiff in the Resources folder). `null` means the
 *     notification should be `silent: true`.
 */

import path from 'node:path';

export type NotificationSoundId =
  | 'none'
  | 'greychrist_success'
  | 'Basso'
  | 'Blow'
  | 'Bottle'
  | 'Frog'
  | 'Funk'
  | 'Glass'
  | 'Hero'
  | 'Morse'
  | 'Ping'
  | 'Pop'
  | 'Purr'
  | 'Sosumi'
  | 'Submarine'
  | 'Tink';

const SYSTEM_SOUND_IDS: ReadonlySet<NotificationSoundId> = new Set([
  'Basso',
  'Blow',
  'Bottle',
  'Frog',
  'Funk',
  'Glass',
  'Hero',
  'Morse',
  'Ping',
  'Pop',
  'Purr',
  'Sosumi',
  'Submarine',
  'Tink',
]);

const VALID_IDS: ReadonlySet<string> = new Set<NotificationSoundId>([
  'none',
  'greychrist_success',
  ...SYSTEM_SOUND_IDS,
]);

export function isNotificationSoundId(value: unknown): value is NotificationSoundId {
  return typeof value === 'string' && VALID_IDS.has(value);
}

export interface NotificationSoundResolution {
  afplayPath: string | null;
  nativeName: string | null;
}

export interface SoundResolverDeps {
  /** Absolute path to the unpacked app directory (e.g. `app.getAppPath()`). */
  appPath: string;
  /** Absolute path to the packaged Resources dir (e.g. `process.resourcesPath`). */
  resourcesPath: string;
  /** Whether the app is running packaged (vs `npm start`). */
  isPackaged: boolean;
}

export function resolveNotificationSound(
  id: NotificationSoundId,
  deps: SoundResolverDeps,
): NotificationSoundResolution {
  if (id === 'none') {
    return { afplayPath: null, nativeName: null };
  }
  if (id === 'greychrist_success') {
    const aiff = deps.isPackaged
      ? path.join(deps.resourcesPath, 'assets', 'greychrist_success.aiff')
      : path.join(deps.appPath, 'assets', 'greychrist_success.aiff');
    return { afplayPath: aiff, nativeName: 'greychrist_success' };
  }
  if (SYSTEM_SOUND_IDS.has(id)) {
    return {
      afplayPath: `/System/Library/Sounds/${id}.aiff`,
      nativeName: id,
    };
  }
  // Should be unreachable given the type, but stay defensive at the
  // settings/IPC boundary where a stale persisted value could leak in.
  return { afplayPath: null, nativeName: null };
}

export interface NotificationSoundsService {
  preview(id: string): { played: boolean; path: string | null };
}

export interface NotificationSoundsServiceDeps extends SoundResolverDeps {
  /** Indirection so tests can substitute afplay. */
  play: (path: string) => void;
}

export function createNotificationSoundsService(
  deps: NotificationSoundsServiceDeps,
): NotificationSoundsService {
  return {
    preview(id) {
      if (!isNotificationSoundId(id)) return { played: false, path: null };
      const resolved = resolveNotificationSound(id, deps);
      if (!resolved.afplayPath) return { played: false, path: null };
      deps.play(resolved.afplayPath);
      return { played: true, path: resolved.afplayPath };
    },
  };
}

// The daemon maps these ids to files and `Notification.sound` (daemon/services/notification-sounds.ts): keep in sync.

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

export interface NotificationSoundChoice {
  id: NotificationSoundId;
  label: string;
}

export const NOTIFICATION_SOUND_CHOICES: readonly NotificationSoundChoice[] = [
  { id: 'none', label: 'No sound' },
  { id: 'greychrist_success', label: 'OmniFex Chime' },
  { id: 'Basso', label: 'Basso' },
  { id: 'Blow', label: 'Blow' },
  { id: 'Bottle', label: 'Bottle' },
  { id: 'Frog', label: 'Frog' },
  { id: 'Funk', label: 'Funk' },
  { id: 'Glass', label: 'Glass' },
  { id: 'Hero', label: 'Hero' },
  { id: 'Morse', label: 'Morse' },
  { id: 'Ping', label: 'Ping' },
  { id: 'Pop', label: 'Pop' },
  { id: 'Purr', label: 'Purr' },
  { id: 'Sosumi', label: 'Sosumi' },
  { id: 'Submarine', label: 'Submarine' },
  { id: 'Tink', label: 'Tink' },
];

export const DEFAULT_SUCCESS_SOUND: NotificationSoundId = 'greychrist_success';
export const DEFAULT_ERROR_SOUND: NotificationSoundId = 'Basso';

const VALID_IDS: ReadonlySet<string> = new Set(
  NOTIFICATION_SOUND_CHOICES.map((c) => c.id),
);

export function isNotificationSoundId(value: unknown): value is NotificationSoundId {
  return typeof value === 'string' && VALID_IDS.has(value);
}

export function normalizeNotificationSoundId(
  value: string | null | undefined,
  fallback: NotificationSoundId,
): NotificationSoundId {
  return isNotificationSoundId(value) ? value : fallback;
}

/** On unless 'false'; the daemon reads it per notification, so turning it off quiets running sessions. */
export const MOD_NOTIFICATIONS_SETTING_KEY = 'mod_notifications_enabled';

export function modNotificationsEnabled(value: string | null | undefined): boolean {
  return value !== 'false';
}

export const NOTIFICATION_SOUND_SETTING_KEYS = {
  success: 'notification_sound_success',
  error: 'notification_sound_error',
} as const;

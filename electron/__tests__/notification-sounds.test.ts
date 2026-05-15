import { describe, it, expect, vi } from 'vitest';
import {
  createNotificationSoundsService,
  resolveNotificationSound,
  isNotificationSoundId,
} from '../services/notification-sounds';

describe('resolveNotificationSound', () => {
  const deps = {
    appPath: '/app',
    resourcesPath: '/resources',
    isPackaged: false,
  };

  it('returns null path and native for "none"', () => {
    expect(resolveNotificationSound('none', deps)).toEqual({
      afplayPath: null,
      nativeName: null,
    });
  });

  it('maps the bundled chime to the dev assets path when not packaged', () => {
    expect(resolveNotificationSound('greychrist_success', deps)).toEqual({
      afplayPath: '/app/assets/greychrist_success.aiff',
      nativeName: 'greychrist_success',
    });
  });

  it('maps the bundled chime to the Resources dir when packaged', () => {
    expect(
      resolveNotificationSound('greychrist_success', { ...deps, isPackaged: true }),
    ).toEqual({
      afplayPath: '/resources/assets/greychrist_success.aiff',
      nativeName: 'greychrist_success',
    });
  });

  it('maps system sound IDs to /System/Library/Sounds and the bare native name', () => {
    expect(resolveNotificationSound('Glass', deps)).toEqual({
      afplayPath: '/System/Library/Sounds/Glass.aiff',
      nativeName: 'Glass',
    });
    expect(resolveNotificationSound('Basso', deps)).toEqual({
      afplayPath: '/System/Library/Sounds/Basso.aiff',
      nativeName: 'Basso',
    });
  });
});

describe('isNotificationSoundId', () => {
  it('accepts every catalog entry', () => {
    for (const id of ['none', 'greychrist_success', 'Glass', 'Basso', 'Hero']) {
      expect(isNotificationSoundId(id)).toBe(true);
    }
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isNotificationSoundId('NotARealSound')).toBe(false);
    expect(isNotificationSoundId(123)).toBe(false);
    expect(isNotificationSoundId(undefined)).toBe(false);
    expect(isNotificationSoundId(null)).toBe(false);
  });
});

describe('notification sounds service', () => {
  const baseDeps = {
    appPath: '/app',
    resourcesPath: '/resources',
    isPackaged: false,
  };

  it('plays the resolved file path for a valid ID', () => {
    const play = vi.fn();
    const svc = createNotificationSoundsService({ ...baseDeps, play });
    expect(svc.preview('Glass')).toEqual({
      played: true,
      path: '/System/Library/Sounds/Glass.aiff',
    });
    expect(play).toHaveBeenCalledWith('/System/Library/Sounds/Glass.aiff');
  });

  it('does not play and returns played: false for "none"', () => {
    const play = vi.fn();
    const svc = createNotificationSoundsService({ ...baseDeps, play });
    expect(svc.preview('none')).toEqual({ played: false, path: null });
    expect(play).not.toHaveBeenCalled();
  });

  it('does not play and returns played: false for an unknown ID', () => {
    const play = vi.fn();
    const svc = createNotificationSoundsService({ ...baseDeps, play });
    expect(svc.preview('NotARealSound')).toEqual({ played: false, path: null });
    expect(play).not.toHaveBeenCalled();
  });
});

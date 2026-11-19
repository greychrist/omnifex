import { describe, it, expect } from 'vitest';
import { createDefaultConfig, mergeConfig, parseConfig, resolveKind, serializeConfig } from '@/lib/messageRenderingConfig';
import { GREG_RENDERING_CONFIG } from './fixtures/gregRenderingConfig';

// Greg's rule (2026-11-18): what Modern shows today is what Standard shows
// after the change, whatever the old Compact/Verbose labels said. The
// goldens prove it record by record; these pin the shape it is written in.
describe('v5 → v6 migration', () => {
  it('writes standard at the level it was set', () => {
    const cfg = mergeConfig(GREG_RENDERING_CONFIG);
    expect(cfg.version).toBe(6);
    // Greg hid System and Live as whole categories.
    expect(cfg.categories.system.standard).toBe(false);
    expect(cfg.categories.live.standard).toBe(false);
    expect(cfg.categories.user.standard).toBe(true);
    // A kind he set to Always, in a category the registry hid it in.
    expect(cfg.kinds['custom-title']?.standard).toBe(true);
    // Kinds he set to Verbose or Never come out hidden.
    expect(resolveKind(cfg, 'queue-operation').standard).toBe(false);
    expect(resolveKind(cfg, 'permission-mode').standard).toBe(false);
    // A kind he only recolored gets no standard of its own.
    expect(cfg.kinds['user.skillInjection']).toEqual({ accentColor: '#d09eff' });
  });

  it('keeps colors and icons, and drops the classic card fields', () => {
    const cfg = mergeConfig(GREG_RENDERING_CONFIG);
    expect(cfg.kinds['system.notification.stop']).toEqual({ icon: 'AlertTriangle' });
    expect(Object.keys(cfg.categories.user).sort()).toEqual(['accentColor', 'description', 'icon', 'label', 'standard']);
    expect(cfg).not.toHaveProperty('hiddenEvents');
    expect(cfg.typography).not.toHaveProperty('header');
    expect(cfg.modern).not.toHaveProperty('recordRules');
  });

  it('migrates recordRules verbose and all', () => {
    const verbose = mergeConfig({ version: 5, modern: { recordRules: 'verbose' } });
    // Verbose showed every kind not set to Never: System's records included.
    expect(resolveKind(verbose, 'system.init').standard).toBe(true);
    expect(resolveKind(verbose, 'system.hook_started').standard).toBe(false);
    const all = mergeConfig({ version: 5, modern: { recordRules: 'all' } });
    expect(resolveKind(all, 'system.hook_started').standard).toBe(true);
  });

  it('keeps card radius and border opacity, which Modern reads', () => {
    const cfg = mergeConfig({ version: 5, cardBorderRadius: 7, cardBorderOpacity: 40 });
    expect(cfg.cardBorderRadius).toBe(7);
    expect(cfg.cardBorderOpacity).toBe(40);
  });

  it('resets anything that is not v5 or v6', () => {
    for (const saved of [null, 'x', 42, { version: 4 }, { version: 7 }]) {
      expect(mergeConfig(saved)).toEqual(createDefaultConfig());
    }
  });

  it('round-trips v6', () => {
    const cfg = mergeConfig(GREG_RENDERING_CONFIG);
    expect(parseConfig(serializeConfig(cfg))).toEqual(cfg);
  });
});

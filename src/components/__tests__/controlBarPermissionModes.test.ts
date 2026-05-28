import { describe, it, expect } from 'vitest';
import { PERMISSION_MODES } from '../ControlBar';

describe('ControlBar PERMISSION_MODES', () => {
  it('exposes exactly the SDK permission mode set', () => {
    expect(PERMISSION_MODES.map((m) => m.id)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'dontAsk',
      'auto',
      'bypassPermissions',
    ]);
  });

  it('uses spec-aligned labels and short names', () => {
    const byId = Object.fromEntries(PERMISSION_MODES.map((m) => [m.id, m]));

    expect(byId.default.name).toBe('Default');
    expect(byId.default.shortName).toBe('DEF');

    expect(byId.acceptEdits.name).toBe('Accept Edits');
    expect(byId.acceptEdits.shortName).toBe('EDIT');

    expect(byId.plan.name).toBe('Plan');
    expect(byId.plan.shortName).toBe('PLAN');

    expect(byId.dontAsk.name).toBe('No Prompts');
    expect(byId.dontAsk.shortName).toBe('DENY');

    expect(byId.auto.name).toBe('Auto Review');
    expect(byId.auto.shortName).toBe('AUTO');

    expect(byId.bypassPermissions.name).toBe('Bypass');
    expect(byId.bypassPermissions.shortName).toBe('ALL');
  });

  it('maps colors to match Claude Code (auto=yellow, plan=blue-green, acceptEdits=purple, bypass=red)', () => {
    const byId = Object.fromEntries(PERMISSION_MODES.map((m) => [m.id, m]));
    expect(byId.default.color).toBe('text-green-600');
    expect(byId.acceptEdits.color).toBe('text-purple-600');
    expect(byId.plan.color).toBe('text-teal-600');
    expect(byId.dontAsk.color).toBe('text-slate-600');
    expect(byId.auto.color).toBe('text-yellow-600');
    expect(byId.bypassPermissions.color).toBe('text-red-600');
  });

  it('does NOT call bypassPermissions "Auto Approve"', () => {
    const bypass = PERMISSION_MODES.find((m) => m.id === 'bypassPermissions');
    expect(bypass?.name).not.toBe('Auto Approve');
  });

  it('every entry has a non-empty description and a renderable icon', () => {
    for (const mode of PERMISSION_MODES) {
      expect(mode.description.length).toBeGreaterThan(0);
      expect(mode.icon).toBeTruthy();
    }
  });
});

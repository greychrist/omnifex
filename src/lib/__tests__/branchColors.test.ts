import { describe, it, expect } from 'vitest';
import { resolveBranchColors, BRANCH_COLORS_PALETTE } from '@/lib/branchColors';

describe('resolveBranchColors', () => {
  it('returns black trunk style for main', () => {
    const r = resolveBranchColors({ pins: {}, mainFolderBranch: 'main', branches: ['main'] });
    expect(r.trunkBlack.has('main')).toBe(true);
    expect(r.colors.main).toBeUndefined();
  });

  it('returns black trunk style for master', () => {
    const r = resolveBranchColors({ pins: {}, mainFolderBranch: 'master', branches: ['master'] });
    expect(r.trunkBlack.has('master')).toBe(true);
  });

  it('returns blue for the main folder branch when not trunk', () => {
    const r = resolveBranchColors({ pins: {}, mainFolderBranch: 'develop', branches: ['develop'] });
    expect(r.colors.develop).toBe('#3b82f6');
    expect(r.trunkBlack.has('develop')).toBe(false);
  });

  it('honors a user pin over auto rules (including trunk)', () => {
    const r = resolveBranchColors({
      pins: { main: '#ef4444', develop: '#10b981' },
      mainFolderBranch: 'develop',
      branches: ['main', 'develop'],
    });
    expect(r.colors.main).toBe('#ef4444');
    expect(r.trunkBlack.has('main')).toBe(false);
    expect(r.colors.develop).toBe('#10b981');
  });

  it('cycles worktree branches without colliding with trunk-black or main-folder blue', () => {
    const r = resolveBranchColors({
      pins: {},
      mainFolderBranch: 'develop',
      branches: ['develop', 'wt-1', 'wt-2', 'wt-3'],
    });
    expect(r.colors.develop).toBe('#3b82f6');
    const wts = ['wt-1', 'wt-2', 'wt-3'].map((b) => r.colors[b]);
    expect(new Set(wts).size).toBe(3);
    expect(wts.includes('#3b82f6')).toBe(false);
  });

  it('skips pinned colors when assigning later branches', () => {
    const r = resolveBranchColors({
      pins: { 'wt-1': '#10b981' },
      mainFolderBranch: 'develop',
      branches: ['develop', 'wt-1', 'wt-2', 'wt-3'],
    });
    expect(r.colors['wt-1']).toBe('#10b981');
    expect([r.colors['wt-2'], r.colors['wt-3']]).not.toContain('#10b981');
    expect([r.colors['wt-2'], r.colors['wt-3']]).not.toContain('#3b82f6');
  });

  it('falls back to hash when palette is exhausted', () => {
    const branches = ['develop', ...Array.from({ length: BRANCH_COLORS_PALETTE.length + 2 }, (_, i) => `wt-${i}`)];
    const r = resolveBranchColors({ pins: {}, mainFolderBranch: 'develop', branches });
    for (const b of branches) {
      expect(r.colors[b] ?? null).not.toBe(null);
    }
  });

  it('handles null mainFolderBranch (no repo)', () => {
    const r = resolveBranchColors({ pins: {}, mainFolderBranch: null, branches: [] });
    expect(r.colors).toEqual({});
    expect(r.trunkBlack.size).toBe(0);
  });
});

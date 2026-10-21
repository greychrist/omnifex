import { describe, it, expect } from 'vitest';
import { readContext } from '@/components/SessionContextDetails';
import type { SessionContextUsage, SessionContextUsageCategory } from '@/lib/api';

const FREE_COLOR = 'rgba(148, 163, 184, 0.35)';

const usage = (categories: SessionContextUsageCategory[]): SessionContextUsage => ({
  categories,
  totalTokens: 50_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  percentage: 25,
  model: 'claude-opus-5-5',
});

const bandsOf = (categories: SessionContextUsageCategory[], contextLimit = 200_000) =>
  readContext({ totalTokens: 0, contextLimit, contextUsage: usage(categories) })!.bands;

describe('readContext free-space detection', () => {
  it('classifies rows by the CLI row id (2.1.304+), not the English name', () => {
    const bands = bandsOf([
      { id: 'custom_agents', name: 'Agents available', tokens: 1_000, color: 'x' },
      { id: 'free_space', name: 'Unused', tokens: 100_000, color: 'x' },
    ]);
    expect(bands.find((b) => b.name === 'Agents available')!.color).not.toBe(FREE_COLOR);
    expect(bands.find((b) => b.name === 'Unused')!.color).toBe(FREE_COLOR);
  });

  it('keeps an id-bearing used row when the window is clamped', () => {
    const bands = bandsOf(
      [
        { id: 'custom_agents', name: 'Agents available', tokens: 1_000, color: 'x' },
        { id: 'free_space', name: 'Unused', tokens: 100_000, color: 'x' },
      ],
      100_000,
    );
    expect(bands.map((b) => b.name)).toContain('Agents available');
    expect(bands.map((b) => b.name)).not.toContain('Unused');
  });

  it('falls back to the name for a CLI that sends no id', () => {
    const bands = bandsOf([
      { name: 'Messages', tokens: 1_000, color: 'x' },
      { name: 'Free space', tokens: 100_000, color: 'x' },
    ]);
    expect(bands.find((b) => b.name === 'Free space')!.color).toBe(FREE_COLOR);
    expect(bands.find((b) => b.name === 'Messages')!.color).not.toBe(FREE_COLOR);
  });
});

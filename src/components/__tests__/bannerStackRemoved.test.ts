import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');

const REMOVED = [
  'components/ContextPressureBanner.tsx',
  'components/SessionNotices.tsx',
  'components/AccountMismatchBanner.tsx',
  'components/claude-code-session/ThinkingBar.tsx',
  'components/claude-code-session/UsageLimitBanner.tsx',
];

describe('the banner stack', () => {
  it.each(REMOVED)('no longer ships %s', (relativePath) => {
    expect(existsSync(resolve(root, relativePath))).toBe(false);
  });

  it('is not importable from the session component', () => {
    const source = readFileSync(resolve(root, 'components/AgentSession.tsx'), 'utf8');
    const imports = source.match(/^import .*$/gm) ?? [];

    const revived = imports.filter((line) =>
      /ContextPressureBanner|SessionNotices|AccountMismatchBanner|ThinkingBar|UsageLimitBanner/.test(line),
    );

    expect(revived).toEqual([]);
  });

  it('mounts exactly one attention surface above the composer', () => {
    const source = readFileSync(resolve(root, 'components/AgentSession.tsx'), 'utf8');
    const mounts = source.match(/<AttentionSlot\b/g) ?? [];

    expect(mounts).toHaveLength(1);
  });
});

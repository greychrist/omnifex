import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Guards the point of the session-signals refactor.
 *
 * The stacked-banner design did not arrive all at once — it accreted, one
 * well-reasoned banner at a time, until five of them competed for the strip
 * above the transcript. Each addition was locally correct; the sum was not.
 * A rendering test would only prove that today's tree is clean, so this asserts
 * the structural fact instead: the components are gone, and the session cannot
 * import them back.
 *
 * If you are here because this test failed, the question to answer first is
 * which anchor your new notice belongs to — not where to put another bar. See
 * `src/lib/signals/types.ts`.
 */

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
    // Two AttentionSlots would be the banner stack growing back under a new
    // name, which is the failure this whole refactor exists to prevent.
    const source = readFileSync(resolve(root, 'components/AgentSession.tsx'), 'utf8');
    const mounts = source.match(/<AttentionSlot\b/g) ?? [];

    expect(mounts).toHaveLength(1);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A badge must be able to explain itself and to go away.
 *
 * Both halves shipped broken, and neither is visible in a rendering test of one
 * component:
 *
 *  - The `account` badge counted an anchor with no `event` emitter at all. It
 *    rendered `count={0}` forever, so it was dead code that read as a feature.
 *  - The `mcp` badge counted skipped servers but nothing ever called
 *    `markRead('mcp')`, so the number could only ever go up. Opening the panel
 *    it points at did not clear it.
 *
 * The invariant is structural, so it is asserted structurally: every anchor
 * that renders a `SignalBadge` needs an `event` emitter to feed it and a
 * `markRead` call to clear it.
 */

const root = resolve(__dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

/** Components allowed to mount a badge. Extend deliberately, not by accident. */
const BADGE_HOSTS = ['components/SessionCard.tsx', 'components/AgentSession.tsx'];

const emitters = read('lib/signals/emitters.ts');
const hostSources = BADGE_HOSTS.map(read).join('\n');

/** Anchors named by a `<SignalBadge label="..." />`, via the count they read. */
function badgedAnchors(): string[] {
  const found = new Set<string>();
  for (const match of hostSources.matchAll(/unreadFor\(\s*'([a-z]+)'\s*\)/g)) {
    found.add(match[1]);
  }
  // SessionCard takes its count as a prop rather than calling the hook, so the
  // anchor it renders is named at the call site in AgentSession.
  return [...found];
}

/** Anchors with at least one `kind: 'event'` emitter feeding them. */
function eventAnchors(): string[] {
  const found = new Set<string>();
  // The emitters name kind and anchor on adjacent lines, in either order, and
  // some carry an `as const` suffix.
  for (const match of emitters.matchAll(
    /kind:\s*'event'(?:\s+as\s+const)?,\s*\n\s*anchor:\s*'([a-z]+)'/g,
  )) {
    found.add(match[1]);
  }
  return [...found];
}

describe('signal badges', () => {
  it('only count anchors that something actually emits events for', () => {
    const withEvents = eventAnchors();
    expect(withEvents.length).toBeGreaterThan(0);

    const orphaned = badgedAnchors().filter((anchor) => !withEvents.includes(anchor));
    expect(orphaned).toEqual([]);
  });

  it('can always be cleared, so a count is never permanent', () => {
    const unclearable = badgedAnchors().filter(
      (anchor) => !new RegExp(`markRead\\(\\s*'${anchor}'\\s*\\)`).test(hostSources),
    );
    expect(unclearable).toEqual([]);
  });
});

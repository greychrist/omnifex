import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

const BADGE_HOSTS = ['components/SessionCard.tsx', 'components/AgentSession.tsx'];

const emitters = read('lib/signals/emitters.ts');
const hostSources = BADGE_HOSTS.map(read).join('\n');

function badgedAnchors(): string[] {
  const found = new Set<string>();
  for (const match of hostSources.matchAll(/unreadFor\(\s*'([a-z]+)'\s*\)/g)) {
    found.add(match[1]);
  }
  // SessionCard takes its count as a prop rather than calling the hook, so the
  // anchor it renders is named at the call site in AgentSession.
  return [...found];
}

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

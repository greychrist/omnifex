import { describe, it, expect } from 'vitest';
import { pickSessionTitle, deriveSessionTitle } from '../sessionTitle';
import type { JsonlNode } from '@/types/jsonl';

const aiTitle = (aiTitle: string): JsonlNode =>
  ({ kind: 'ai-title', raw: { type: 'ai-title', aiTitle }, sessionId: 's' }) as unknown as JsonlNode;

const customTitle = (customTitle: string): JsonlNode =>
  ({ kind: 'custom-title', raw: { type: 'custom-title', customTitle }, sessionId: 's' }) as unknown as JsonlNode;

describe('pickSessionTitle', () => {
  // The CLI reads the two records independently and lets a rename win, no
  // matter which record was written last. Anything that shows a session's
  // name has to resolve them the same way or the app and the CLI disagree
  // about what the session is called.
  it('prefers a rename over the CLI’s own generated title', () => {
    expect(pickSessionTitle({ aiTitle: 'Generated', customTitle: 'Renamed' })).toBe('Renamed');
  });

  it('falls back to the generated title when there is no rename', () => {
    expect(pickSessionTitle({ aiTitle: 'Generated' })).toBe('Generated');
  });

  it('returns null when the session has neither', () => {
    expect(pickSessionTitle({})).toBeNull();
  });

  // A rename to empty is how the CLI clears a custom title (saveCustomTitle
  // writes `customTitle: ""`), so blank must fall through to the generated
  // one rather than showing an empty name.
  it('treats a blank rename as no rename', () => {
    expect(pickSessionTitle({ aiTitle: 'Generated', customTitle: '   ' })).toBe('Generated');
  });

  it('trims what it returns', () => {
    expect(pickSessionTitle({ customTitle: '  Renamed  ' })).toBe('Renamed');
  });
});

describe('deriveSessionTitle', () => {
  it('reads the title out of the transcript the CLI wrote', () => {
    expect(deriveSessionTitle([aiTitle('Generated')])).toBe('Generated');
  });

  // The CLI rewrites `ai-title` every turn. Every copy holds the same value
  // in practice, but the last one is the one it settled on.
  it('takes the last record of each type', () => {
    expect(deriveSessionTitle([aiTitle('First guess'), aiTitle('Settled on')])).toBe('Settled on');
  });

  // Ordering is the trap: the CLI keeps re-emitting `ai-title` after a
  // rename, so "last record in the file wins" would flip the name back.
  it('keeps a rename even when an ai-title is appended after it', () => {
    const messages = [aiTitle('Generated'), customTitle('Renamed'), aiTitle('Generated')];
    expect(deriveSessionTitle(messages)).toBe('Renamed');
  });

  it('returns null for a transcript with no title records', () => {
    expect(deriveSessionTitle([])).toBeNull();
  });
});

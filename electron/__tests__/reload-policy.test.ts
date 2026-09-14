import { describe, it, expect } from 'vitest';
import { decideReload } from '../reload-policy';

describe('decideReload', () => {
  it('always confirms — the dialog is what replaces the removed Cmd+R', () => {
    expect(decideReload({ workingCount: 0 }).action).toBe('confirm');
    expect(decideReload({ workingCount: 5 }).action).toBe('confirm');
  });

  it('names what a reload actually costs', () => {
    const { prompt } = decideReload({ workingCount: 0 });
    expect(prompt.detail).toMatch(/drafts/i);
    expect(prompt.detail).toMatch(/queued prompts/i);
  });

  it('reassures that live sessions survive, and counts them', () => {
    const { prompt } = decideReload({ workingCount: 3 });
    expect(prompt.detail).toMatch(/3 sessions keep running/);
  });

  it('uses the singular for one working session', () => {
    const { prompt } = decideReload({ workingCount: 1 });
    expect(prompt.detail).toMatch(/1 session keeps running/);
  });

  it('says nothing about sessions when none are working', () => {
    const { prompt } = decideReload({ workingCount: 0 });
    expect(prompt.detail).not.toMatch(/keep(s)? running/);
  });

  it('treats a NaN count as "none working" rather than rendering NaN at the user', () => {
    // `workingCount` comes from the same live aggregator quit-policy guards
    // against, which can report from a window being torn down.
    const { prompt } = decideReload({ workingCount: Number.NaN });
    expect(prompt.detail).not.toMatch(/NaN/);
    expect(prompt.detail).not.toMatch(/keep(s)? running/);
  });
});

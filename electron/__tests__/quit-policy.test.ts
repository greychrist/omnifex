import { describe, it, expect } from 'vitest';
import { decideQuit } from '../quit-policy';

describe('decideQuit', () => {
  it('allows the quit when nothing is working', () => {
    expect(decideQuit({ workingCount: 0, authorized: false })).toEqual({ action: 'allow' });
  });

  it('asks before ending work in flight', () => {
    const decision = decideQuit({ workingCount: 2, authorized: false });
    expect(decision.action).toBe('confirm');
  });

  // The update installer already gates on busy sessions and then quits to
  // swap the bundle. A second prompt there could cancel a quit that is
  // halfway through an install, so an authorized quit is never questioned.
  it('never questions an authorized quit', () => {
    expect(decideQuit({ workingCount: 3, authorized: true })).toEqual({ action: 'allow' });
  });

  it('names a single session in the singular', () => {
    const decision = decideQuit({ workingCount: 1, authorized: false });
    expect(decision.action === 'confirm' && decision.prompt.message).toMatch(/1 session is/);
  });

  it('names several sessions in the plural', () => {
    const decision = decideQuit({ workingCount: 4, authorized: false });
    expect(decision.action === 'confirm' && decision.prompt.message).toMatch(/4 sessions are/);
  });

  it('says what quitting will do', () => {
    const decision = decideQuit({ workingCount: 1, authorized: false });
    expect(decision.action === 'confirm' && decision.prompt.detail).toMatch(/stop/i);
  });

  // The count comes from a live aggregator that can be momentarily empty or
  // report from a torn-down window. A garbage count must not wedge the app
  // behind a dialog the user cannot satisfy.
  it('treats a nonsense count as nothing working', () => {
    expect(decideQuit({ workingCount: -1, authorized: false })).toEqual({ action: 'allow' });
    expect(decideQuit({ workingCount: Number.NaN, authorized: false })).toEqual({
      action: 'allow',
    });
  });
});

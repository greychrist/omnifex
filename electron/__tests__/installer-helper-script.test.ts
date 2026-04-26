import { describe, it, expect } from 'vitest';
import { buildHelperScript } from '../services/installer/helper-script';

describe('buildHelperScript', () => {
  it('substitutes parent PID, target app, and staged app paths', () => {
    const script = buildHelperScript({
      parentPid: 12345,
      targetAppPath: '/Applications/GreyChrist.app',
      stagedAppPath: '/tmp/stage/GreyChrist.app',
    });
    expect(script).toContain('PARENT_PID=12345');
    expect(script).toContain('TARGET_APP="/Applications/GreyChrist.app"');
    expect(script).toContain('STAGED_APP="/tmp/stage/GreyChrist.app"');
    expect(script).toContain('while kill -0 "$PARENT_PID"');
    expect(script).toContain('rm -rf "$TARGET_APP"');
    expect(script).toContain('ditto "$STAGED_APP" "$TARGET_APP"');
    expect(script).toContain('open "$TARGET_APP"');
  });

  it('refuses paths containing double-quotes (defensive)', () => {
    expect(() => buildHelperScript({
      parentPid: 1,
      targetAppPath: '/Applications/Bad"Name.app',
      stagedAppPath: '/tmp/x',
    })).toThrow(/quote/i);
  });

  it('starts with a shebang', () => {
    const script = buildHelperScript({ parentPid: 1, targetAppPath: '/a', stagedAppPath: '/b' });
    expect(script.startsWith('#!/bin/sh')).toBe(true);
  });
});

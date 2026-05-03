import { describe, it, expect } from 'vitest';
import { buildHelperScript } from '../services/installer/helper-script';

describe('buildHelperScript', () => {
  it('substitutes parent PID, target app, and staged app paths', () => {
    const script = buildHelperScript({
      parentPid: 12345,
      targetAppPath: '/Applications/OmniFex.app',
      stagedAppPath: '/tmp/stage/OmniFex.app',
    });
    expect(script).toContain('PARENT_PID=12345');
    expect(script).toContain('TARGET_APP="/Applications/OmniFex.app"');
    expect(script).toContain('STAGED_APP="/tmp/stage/OmniFex.app"');
    expect(script).toContain('while kill -0 "$PARENT_PID"');
    expect(script).toContain('rm -rf "$TARGET_APP"');
    expect(script).toContain('ditto "$STAGED_APP" "$TARGET_APP"');
    expect(script).toContain('open "$TARGET_APP"');
  });

  it('refuses paths containing shell-unsafe characters (defensive)', () => {
    const bad = (targetAppPath: string, stagedAppPath = '/tmp/x') =>
      () => buildHelperScript({ parentPid: 1, targetAppPath, stagedAppPath });

    // double-quote
    expect(bad('/Applications/Bad"Name.app')).toThrow(/shell-unsafe/i);
    // dollar sign
    expect(bad('/Applications/Bad$Name.app')).toThrow(/shell-unsafe/i);
    // backtick
    expect(bad('/Applications/Bad`Name.app')).toThrow(/shell-unsafe/i);
    // newline
    expect(bad('/Applications/Bad\nName.app')).toThrow(/shell-unsafe/i);
    // also catches dangerous chars in stagedAppPath
    expect(bad('/Applications/Good.app', '/tmp/bad$path')).toThrow(/shell-unsafe/i);
  });

  it('starts with a shebang', () => {
    const script = buildHelperScript({ parentPid: 1, targetAppPath: '/a', stagedAppPath: '/b' });
    expect(script.startsWith('#!/bin/sh')).toBe(true);
  });
});

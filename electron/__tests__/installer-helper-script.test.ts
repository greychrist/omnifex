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

  // The stage dir is a mkdtemp folder that holds only the staged app; removing
  // just the app left one empty omnifex-stage-* folder behind per install.
  it('removes the whole stage dir once the new app is in place', () => {
    const script = buildHelperScript({
      parentPid: 1,
      targetAppPath: '/Applications/OmniFex.app',
      stagedAppPath: '/var/T/omnifex-stage-AbC123/OmniFex.app',
    });
    expect(script).toContain('rm -rf "/var/T/omnifex-stage-AbC123"');
    expect(script.indexOf('open "$TARGET_APP"')).toBeLessThan(script.indexOf('rm -rf "/var/T/omnifex-stage-AbC123"'));
  });

  it('never removes a parent that is not an omnifex-stage dir', () => {
    const script = buildHelperScript({
      parentPid: 1,
      targetAppPath: '/Applications/OmniFex.app',
      stagedAppPath: '/tmp/OmniFex.app',
    });
    expect(script).not.toContain('rm -rf "/tmp"');
    expect(script).toContain('rm -rf "$STAGED_APP"');
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

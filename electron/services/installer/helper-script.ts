// Pure function — no FS, no spawn. Builds the POSIX shell script that runs
// after the Electron parent quits, replaces the running .app bundle, and
// relaunches the new copy. Kept separate so the unit tests don't have to
// mock anything to exercise the substitution and quoting rules.

export interface HelperScriptParams {
  parentPid: number;
  /** Absolute path to the running OmniFex.app bundle. */
  targetAppPath: string;
  /** Absolute path to the extracted (new-version) OmniFex.app bundle. */
  stagedAppPath: string;
}

export function buildHelperScript(params: HelperScriptParams): string {
  const DANGEROUS_CHARS = /["`\\\n\r\t\0$]/;
  if (DANGEROUS_CHARS.test(params.targetAppPath) || DANGEROUS_CHARS.test(params.stagedAppPath)) {
    // Reject shell-unsafe characters defensively. Paths produced by the
    // installer come from process.execPath / os.tmpdir() and won't have them,
    // but a defense-in-depth check guards against any future caller passing
    // attacker-influenced paths into shell.
    throw new Error('helper-script: refusing path containing shell-unsafe character');
  }
  return [
    '#!/bin/sh',
    `PARENT_PID=${params.parentPid}`,
    `TARGET_APP="${params.targetAppPath}"`,
    `STAGED_APP="${params.stagedAppPath}"`,
    'SELF=$0',
    '',
    'while kill -0 "$PARENT_PID" 2>/dev/null; do sleep 0.2; done',
    '',
    'rm -rf "$TARGET_APP" || exit 1',
    'ditto "$STAGED_APP" "$TARGET_APP" || exit 1',
    'open "$TARGET_APP"',
    '',
    'rm -rf "$STAGED_APP"',
    'rm -f "$SELF"',
    '',
  ].join('\n');
}
